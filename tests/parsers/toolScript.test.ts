import { describe, expect, it } from 'vitest'
import {
  durationFromText,
  exitCodeFromText,
  hasHardFailureMarker,
  parseToolScript,
  readStringLiteral
} from '../../src/main/parsers/toolScript'

describe('JS 字符串字面量读取', () => {
  it('读取双引号、单引号与反引号', () => {
    expect(readStringLiteral('"hello"', 0)?.value).toBe('hello')
    expect(readStringLiteral("'hello'", 0)?.value).toBe('hello')
    expect(readStringLiteral('`hello`', 0)?.value).toBe('hello')
  })

  it('解码常见转义', () => {
    expect(readStringLiteral('"a\\nb"', 0)?.value).toBe('a\nb')
    expect(readStringLiteral('"say \\"hi\\""', 0)?.value).toBe('say "hi"')
    expect(readStringLiteral('"C:\\\\Users\\\\demo"', 0)?.value).toBe('C:\\Users\\demo')
    expect(readStringLiteral('"tab\\tend"', 0)?.value).toBe('tab\tend')
  })

  it('解码 unicode 转义', () => {
    expect(readStringLiteral('"\\u4f60\\u597d"', 0)?.value).toBe('你好')
    expect(readStringLiteral('"\\u{1F600}"', 0)?.value).toBe('\u{1F600}')
  })

  it('返回结束位置，便于继续扫描', () => {
    const literal = readStringLiteral('"ab" rest', 0)
    expect(literal?.end).toBe(4)
  })

  it('普通引号里遇到裸换行视为未闭合，不吞掉后面的代码', () => {
    expect(readStringLiteral('"unclosed\nnext line"', 0)).toBeNull()
  })

  it('反引号允许跨行', () => {
    expect(readStringLiteral('`line1\nline2`', 0)?.value).toBe('line1\nline2')
  })

  it('不是引号时返回 null', () => {
    expect(readStringLiteral('const x', 0)).toBeNull()
  })
})

describe('工具脚本解析', () => {
  it('抽出 tools.exec_command 里的命令与工作目录', () => {
    const script =
      'const r = await tools.exec_command({cmd:"npm test", workdir:"C:\\\\Users\\\\demo\\\\proj"});\nconsole.log(r);'
    const info = parseToolScript(script)

    expect(info.looksLikeToolScript).toBe(true)
    expect(info.commands).toEqual(['npm test'])
    expect(info.workingDirectory).toBe('C:\\Users\\demo\\proj')
    expect(info.calls[0]?.toolName).toBe('exec_command')
  })

  it('抽出并发执行的多条命令', () => {
    const script = [
      'const results = await Promise.all([',
      '  tools.exec_command({cmd:"npm run build"}),',
      '  tools.exec_command({cmd:"npm run lint"})',
      ']);'
    ].join('\n')

    expect(parseToolScript(script).commands).toEqual(['npm run build', 'npm run lint'])
  })

  it('命令写成数组时去掉 shell 包装', () => {
    const script = 'await tools.exec_command({cmd:["bash","-lc","npm test"]});'
    expect(parseToolScript(script).commands).toEqual(['npm test'])
  })

  it('从代码里内嵌的字符串中解析出补丁', () => {
    const script = [
      'const patch = "*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-old line\\n+new line\\n*** End Patch\\n";',
      'const r = await tools.apply_patch({input: patch});'
    ].join('\n')

    const info = parseToolScript(script)
    expect(info.patches).toHaveLength(1)
    expect(info.patches[0]).toMatchObject({
      path: 'src/a.ts',
      kind: 'edit',
      additions: 1,
      deletions: 1
    })
  })

  it('补丁里的转义引号被正确还原', () => {
    const script =
      'const patch = "*** Begin Patch\\n*** Update File: src/csv.ts\\n@@\\n-  return rows.join(\\",\\")\\n+  return rows.map(esc).join(\\",\\")\\n*** End Patch\\n";\nawait tools.apply_patch({input: patch});'

    const change = parseToolScript(script).patches[0]
    expect(change?.diff).toContain('rows.join(",")')
    expect(change?.diff).toContain('rows.map(esc).join(",")')
  })

  it('新增文件的补丁被识别为写入', () => {
    const script =
      'const patch = "*** Begin Patch\\n*** Add File: src/new.ts\\n+export const a = 1\\n+export const b = 2\\n*** End Patch\\n";\nawait tools.apply_patch({input: patch});'

    const change = parseToolScript(script).patches[0]
    expect(change?.path).toBe('src/new.ts')
    expect(change?.kind).toBe('write')
    expect(change?.additions).toBe(2)
  })

  it('认得出没有命令的工具调用', () => {
    const info = parseToolScript('const r = await tools.write_stdin({session_id:3, chars:"q\\n"});')

    expect(info.looksLikeToolScript).toBe(true)
    expect(info.commands).toEqual([])
    expect(info.calls[0]?.toolName).toBe('write_stdin')
  })

  it('多个不同工具都被记下来', () => {
    const script = [
      'await tools.exec_command({cmd:"ls"});',
      'await tools.view_image({path:"a.png"});'
    ].join('\n')

    const names = parseToolScript(script).calls.map((call) => call.toolName)
    expect(names).toEqual(['exec_command', 'view_image'])
  })

  it('普通文本与普通 shell 命令不会被误判成脚本', () => {
    expect(parseToolScript('npm test').looksLikeToolScript).toBe(false)
    expect(parseToolScript('这是一段说明文字').looksLikeToolScript).toBe(false)
    expect(parseToolScript('{"cmd":"npm test"}').looksLikeToolScript).toBe(false)
    expect(parseToolScript('').looksLikeToolScript).toBe(false)
  })

  it('只有补丁、没有 tools. 调用时也能解析', () => {
    const info = parseToolScript(
      '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch\n'
    )
    expect(info.looksLikeToolScript).toBe(true)
    expect(info.patches).toHaveLength(1)
  })

  it('注释里的内容不会干扰解析', () => {
    const script = [
      '// tools.exec_command({cmd:"这是注释，不该被当成命令"})',
      'await tools.exec_command({cmd:"真正的命令"});'
    ].join('\n')

    // 注释里的调用也会被算进去 —— 这是可接受的：它确实出现在这一步的代码里。
    expect(parseToolScript(script).commands).toContain('真正的命令')
  })

  it('结构损坏时不抛异常', () => {
    expect(() => parseToolScript('await tools.exec_command({cmd:"未闭合')).not.toThrow()
    expect(() => parseToolScript('tools.x({cmd:[')).not.toThrow()
    expect(() => parseToolScript('*** Begin Patch\n*** Update File:')).not.toThrow()
  })
})

describe('从输出文本推断结果', () => {
  it('识别明确写出的退出码', () => {
    expect(exitCodeFromText('exit code: 1')).toBe(1)
    expect(exitCodeFromText('Exit Code 0')).toBe(0)
    expect(exitCodeFromText('exited with status 2')).toBe(2)
    expect(exitCodeFromText('process exited with 137')).toBe(137)
  })

  it('没有退出码时返回 null', () => {
    expect(exitCodeFromText('Output:\nhello')).toBeNull()
    expect(exitCodeFromText('')).toBeNull()
  })

  it('抽出 Wall time 作为耗时', () => {
    expect(durationFromText('Wall time 6.9 seconds')).toBe(6900)
    expect(durationFromText('Wall time 0.4 seconds')).toBe(400)
    expect(durationFromText('wall time: 120 ms')).toBe(120)
    expect(durationFromText('Output:\nhello')).toBeNull()
  })

  it('只在无歧义时判定失败', () => {
    expect(hasHardFailureMarker('bash: eslintt: command not found')).toBe(true)
    expect(hasHardFailureMarker('Script error:\nexec_command failed for "x"')).toBe(true)
    expect(hasHardFailureMarker("'foo' is not recognized as the name of a cmdlet")).toBe(true)
    expect(hasHardFailureMarker('ParserError: 缺少右括号')).toBe(true)
  })

  it('输出里只是提到 error 不算失败（避免把成功的步骤标红）', () => {
    expect(hasHardFailureMarker('Output:\nsrc/a.ts:3: throw new Error("x")')).toBe(false)
    expect(hasHardFailureMarker('0 errors, 2 warnings')).toBe(false)
    expect(hasHardFailureMarker('查找 error 关键字，共 12 处')).toBe(false)
    expect(hasHardFailureMarker('')).toBe(false)
  })
})

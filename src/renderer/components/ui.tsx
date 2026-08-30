import type { ComponentType, ReactNode } from 'react'
import { LoaderCircle, type LucideProps } from 'lucide-react'
import { cx } from '../lib/format'

/** 一组小而复用度高的基础组件，避免每个页面重复写样式。 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-canvas hover:brightness-110 active:brightness-95 border border-transparent font-semibold',
  secondary:
    'bg-raised text-ink hover:bg-line border border-line',
  ghost: 'bg-transparent text-ink-soft hover:text-ink hover:bg-raised border border-transparent',
  danger: 'bg-transparent text-error hover:bg-error-soft border border-error/40'
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-lg'
}

export interface ButtonProps {
  children?: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ComponentType<LucideProps>
  disabled?: boolean
  loading?: boolean
  title?: string
  className?: string
  active?: boolean
  type?: 'button' | 'submit'
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  disabled = false,
  loading = false,
  title,
  className,
  active = false,
  type = 'button'
}: ButtonProps): React.JSX.Element {
  const iconSize = size === 'sm' ? 13 : size === 'lg' ? 17 : 15
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      aria-pressed={active || undefined}
      className={cx(
        'inline-flex items-center justify-center whitespace-nowrap transition-colors select-none',
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        active && 'ring-1 ring-accent/60 text-accent-ink',
        (disabled || loading) && 'opacity-45 pointer-events-none',
        className
      )}
    >
      {loading ? (
        <LoaderCircle size={iconSize} className="animate-spin" />
      ) : Icon ? (
        <Icon size={iconSize} />
      ) : null}
      {children}
    </button>
  )
}

export function IconButton({
  icon: Icon,
  onClick,
  title,
  active = false,
  disabled = false,
  tone = 'default'
}: {
  icon: ComponentType<LucideProps>
  onClick?: () => void
  title: string
  active?: boolean
  disabled?: boolean
  tone?: 'default' | 'danger'
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
        active
          ? 'border-accent/50 bg-accent-soft text-accent-ink'
          : 'border-transparent text-ink-soft hover:bg-raised hover:text-ink',
        tone === 'danger' && 'hover:text-error hover:bg-error-soft',
        disabled && 'opacity-40 pointer-events-none'
      )}
    >
      <Icon size={15} />
    </button>
  )
}

export function Badge({
  children,
  className,
  title
}: {
  children: ReactNode
  className?: string
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-5 whitespace-nowrap',
        className ?? 'bg-neutral-soft text-ink-soft'
      )}
    >
      {children}
    </span>
  )
}

export function Card({
  children,
  className,
  padded = true
}: {
  children: ReactNode
  className?: string
  padded?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'rounded-xl border border-line bg-surface',
        padded && 'p-4',
        className
      )}
    >
      {children}
    </div>
  )
}

export function SectionTitle({
  children,
  hint
}: {
  children: ReactNode
  hint?: string
}): React.JSX.Element {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <h3 className="text-[13px] font-semibold tracking-wide text-ink-soft uppercase">{children}</h3>
      {hint ? <span className="text-xs text-ink-faint">{hint}</span> : null}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  description
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  description?: string
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx(
          'mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-line bg-raised'
        )}
      >
        <span
          className={cx(
            'block h-4 w-4 rounded-full bg-canvas transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5'
          )}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-sm text-ink">{label}</span>
        {description ? (
          <span className="block text-xs leading-relaxed text-ink-faint">{description}</span>
        ) : null}
      </span>
    </label>
  )
}

export function Spinner({ label }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-soft">
      <LoaderCircle size={16} className="animate-spin" />
      {label ? <span>{label}</span> : null}
    </div>
  )
}

export function ProgressBar({ percent }: { percent: number }): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-raised"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children
}: {
  icon: ComponentType<LucideProps>
  title: string
  description?: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface text-ink-faint">
        <Icon size={24} />
      </div>
      <div className="max-w-sm">
        <p className="text-[15px] font-medium text-ink">{title}</p>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{description}</p>
        ) : null}
      </div>
      {children ? <div className="mt-1 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="py-2">
      <div className="mb-1.5 text-sm text-ink">{label}</div>
      {hint ? <div className="mb-2 text-xs leading-relaxed text-ink-faint">{hint}</div> : null}
      {children}
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  min,
  max,
  className
}: {
  value: string | number
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'number'
  min?: number
  max?: number
  className?: string
}): React.JSX.Element {
  return (
    <input
      type={type}
      value={value}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={cx(
        'h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm text-ink outline-none',
        'placeholder:text-ink-faint focus:border-accent/60',
        className
      )}
    />
  )
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AppProvider } from './hooks/useAppStore'
import './styles/index.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器，页面无法启动。')

createRoot(container).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
)

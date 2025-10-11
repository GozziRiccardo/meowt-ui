// src/main.tsx

// PWA: register a no-op SW in production only (won't cache or intercept fetch)
if (typeof window !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .catch(() => {
        /* ignore */
      })
  })
}

import './polyfills'
import './web3modal'
import './index.css'

import React from 'react'
import { createRoot } from 'react-dom/client'

import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import Landing from './Landing'
import Web3ModalHost from './components/Web3ModalHost'

const router = createBrowserRouter([
  { path: '/', element: <Landing /> },
  { path: '/app', element: <App /> },
])

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
    <Web3ModalHost />
  </React.StrictMode>
)

// src/main.tsx

import './web3modal'   // <- creates the modal (wagmi flavor), once
import './polyfills'

import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import Landing from './Landing'

const router = createBrowserRouter([
  { path: '/', element: <Landing /> },
  { path: '/app', element: <App /> },
])

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
)

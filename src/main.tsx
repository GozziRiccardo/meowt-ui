// src/main.tsx

import './index.css'
import './web3modal'
import './polyfills'

import React from 'react'
import { createRoot } from 'react-dom/client'


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

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AdminApp from './admin/AdminApp.jsx'
import AccountApp from './account/AccountApp.jsx'
import StoreApp from './store/StoreApp.jsx'
import { AuthProvider } from './context/AuthProvider.jsx'
import { AuthModalProvider } from './context/AuthModalContext.jsx'

// No router dependency for two extra routes — both /admin and /account are
// intentionally unlinked from the public site, so a pathname check is all
// this needs. AuthProvider wraps only these two auth-aware surfaces, not
// the public marketing site, which has no use for a Supabase auth
// subscription today. (Update: the homepage is now wrapped as well, for the
// Login / Register modal and the signed-in navigation.)
const pathname = window.location.pathname
const isAdmin = pathname.startsWith('/admin')
const isAccount = pathname.startsWith('/account') || pathname.startsWith('/orders')
const isStore = /^\/(store|cart|checkout)(\/|$)/.test(pathname)

// Friendly aliases for the dashboard routes named in the product brief.
const ALIASES = { '/dashboard': '/account', '/dashboard/bookings': '/account/book', '/dashboard/classes': '/account#classes' }
if (ALIASES[pathname.replace(/\/$/, '')]) window.location.replace(ALIASES[pathname.replace(/\/$/, '')])

function Root() {
  if (isAdmin) {
    return (
      <AuthProvider>
        <AdminApp />
      </AuthProvider>
    )
  }
  if (isAccount) {
    return (
      <AuthProvider>
        <AccountApp />
      </AuthProvider>
    )
  }
  if (isStore) {
    return (
      <AuthProvider>
        <AuthModalProvider>
          <StoreApp />
        </AuthModalProvider>
      </AuthProvider>
    )
  }
  // The homepage now needs the session too (Login/Register + signed-in nav).
  return (
    <AuthProvider>
      <AuthModalProvider>
        <App />
      </AuthModalProvider>
    </AuthProvider>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)

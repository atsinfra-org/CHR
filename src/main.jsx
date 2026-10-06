import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AdminApp from './admin/AdminApp.jsx'
import AccountApp from './account/AccountApp.jsx'
import { AuthProvider } from './context/AuthProvider.jsx'

// No router dependency for two extra routes — both /admin and /account are
// intentionally unlinked from the public site, so a pathname check is all
// this needs. AuthProvider wraps only these two auth-aware surfaces, not
// the public marketing site, which has no use for a Supabase auth
// subscription today.
const pathname = window.location.pathname
const isAdmin = pathname.startsWith('/admin')
const isAccount = pathname.startsWith('/account')

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
  return <App />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)

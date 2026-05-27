import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ScrollToTop } from './components/ScrollToTop'
import { ToastProvider } from './components/Toast'
import LandingPage      from './pages/LandingPage'
import RiderDashboard   from './pages/RiderDashboard'
import DriverDashboard  from './pages/DriverDashboard'
import AdminDashboard   from './pages/AdminDashboard'
import PlaygroundPage   from './pages/DemoPage'
import ArchitecturePage from './pages/ArchitecturePage'

export default function App() {
  return (
    <ToastProvider>
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        <Route path="/"             element={<LandingPage />} />
        <Route path="/playground"   element={<PlaygroundPage />} />
        <Route path="/rider"        element={<RiderDashboard />} />
        <Route path="/driver"       element={<DriverDashboard />} />
        <Route path="/admin"        element={<AdminDashboard />} />
        <Route path="/architecture" element={<ArchitecturePage />} />
        <Route path="/demo"         element={<Navigate to="/playground" replace />} />
        <Route path="*"             element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
    </ToastProvider>
  )
}

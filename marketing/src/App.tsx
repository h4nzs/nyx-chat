import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import { Spinner } from './components/Spinner';

const LandingPage = lazy(() => import('./pages/LandingPage'));
const HelpPage = lazy(() => import('./pages/HelpPage'));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage'));

const LoadingScreen = () => (
  <div className="w-full h-screen flex items-center justify-center bg-bg-main">
    <Spinner size="lg" />
  </div>
);

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingScreen />}>
        <div className="w-full min-h-screen bg-bg-main text-text-primary">
          {/* Anda bisa letakkan Navbar global di sini jika ada */}
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
          </Routes>
          {/* Dan Footer global di sini */}
        </div>
      </Suspense>
    </BrowserRouter>
  );
}

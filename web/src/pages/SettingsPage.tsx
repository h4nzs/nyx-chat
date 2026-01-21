import Settings from '../components/Settings';
import { Link } from 'react-router-dom';

export default function SettingsPage() {
  return (
    <div className="h-screen w-screen flex flex-col bg-bg-main text-text-primary font-sans">
      <header className="p-4 flex items-center gap-4 flex-shrink-0 border-b border-border">
        <Link to="/chat" className="touch-target p-2.5 rounded-full text-text-secondary shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm transition-all">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
        </Link>
        <h1 className="text-xl font-bold text-text-primary">Settings</h1>
      </header>
      <main className="flex-1 overflow-y-auto p-4 md:p-6">
        <Settings />
      </main>
    </div>
  );
}
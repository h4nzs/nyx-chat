import { Component, ReactNode } from 'react';
import { FiAlertTriangle, FiRefreshCw } from 'react-icons/fi';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen w-full flex flex-col items-center justify-center bg-bg-main p-6 text-center text-text-primary">
          <div className="max-w-md w-full flex flex-col items-center space-y-8 animate-in fade-in zoom-in duration-500">
            
            {/* Error Icon */}
            <div className="relative">
              <div className="absolute inset-0 bg-red-500/20 blur-3xl rounded-full" />
              <div className="relative w-32 h-32 rounded-full bg-bg-main shadow-neu-pressed flex items-center justify-center text-red-500">
                 <FiAlertTriangle size={64} />
              </div>
            </div>

            {/* Message */}
            <div className="space-y-4">
              <h1 className="text-2xl font-black uppercase tracking-widest text-red-500">
                System Malfunction
              </h1>
              <div className="bg-bg-surface p-4 rounded-xl border border-red-500/10 shadow-neu-flat">
                <p className="font-mono text-xs text-text-secondary break-all">
                  {this.state.error?.message || "An unexpected error occurred in the React tree."}
                </p>
              </div>
              <p className="text-text-secondary text-sm">
                The application encountered a critical error. A reload is required to restore system integrity.
              </p>
            </div>

            {/* Action Button */}
            <button
              onClick={this.handleReload}
              className="
                group flex items-center gap-3 px-8 py-4 rounded-xl
                bg-bg-main text-text-primary font-bold uppercase tracking-wider text-sm
                shadow-neu-flat hover:text-accent
                active:shadow-neu-pressed active:scale-[0.98]
                transition-all duration-200
              "
            >
              <FiRefreshCw className="text-lg group-hover:rotate-180 transition-transform duration-500" />
              <span>Reboot System</span>
            </button>
          </div>

          <div className="absolute bottom-8 text-[10px] text-text-secondary/30 font-mono uppercase tracking-[0.3em]">
            NYX Secure Protocol // Critical Failure
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

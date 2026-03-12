import { useNavigate } from 'react-router-dom';
import { FiHome, FiAlertCircle } from 'react-icons/fi';
import { motion } from 'framer-motion';

export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-bg-main p-6 text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
        className="max-w-md w-full flex flex-col items-center space-y-8"
      >
        {/* 404 Display */}
        <div className="relative">
          <div className="absolute inset-0 bg-accent/20 blur-3xl rounded-full" />
          <div className="relative w-40 h-40 rounded-full bg-bg-main shadow-neu-pressed flex items-center justify-center">
             <span className="text-6xl font-black text-accent tracking-tighter">404</span>
          </div>
        </div>

        {/* Message */}
        <div className="space-y-3">
          <h1 className="text-2xl font-bold text-text-primary uppercase tracking-wider">
            Page Not Found
          </h1>
          <p className="text-text-secondary font-mono text-sm leading-relaxed">
            The encrypted path you are trying to access does not exist or has been wiped from the system.
          </p>
        </div>

        {/* Action Button */}
        <button
          onClick={() => navigate('/chat')}
          className="
            group flex items-center gap-3 px-8 py-4 rounded-xl
            bg-bg-main text-text-primary font-bold uppercase tracking-wider text-sm
            shadow-neu-flat hover:text-accent
            active:shadow-neu-pressed active:scale-[0.98]
            transition-all duration-200
          "
        >
          <FiHome className="text-lg group-hover:scale-110 transition-transform" />
          <span>Return to Base</span>
        </button>
      </motion.div>

      {/* Footer Decoration */}
      <div className="absolute bottom-8 text-[10px] text-text-secondary/30 font-mono uppercase tracking-[0.3em]">
        NYX Secure Protocol // End of Line
      </div>
    </div>
  );
}

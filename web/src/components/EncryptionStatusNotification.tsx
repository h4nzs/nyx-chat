import { useEffect } from 'react';
import toast, { Toaster } from 'react-hot-toast';

const EncryptionStatusNotification = () => {
  useEffect(() => {
    const checkEncryptionStatus = () => {
      const publicKey = localStorage.getItem('publicKey');
      const encryptedPrivateKey = localStorage.getItem('encryptedPrivateKey');
      const isAvailable = !!(publicKey && encryptedPrivateKey);
      
      if (!isAvailable) {
        // Show notification about encryption not being available
        toast((t) => (
          <div className="p-4 card-neumorphic max-w-sm border border-yellow-300 dark:border-yellow-700 rounded-xl">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-yellow-600 dark:text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                  End-to-end encryption is not enabled
                </h3>
                <div className="mt-2 text-sm text-yellow-700 dark:text-yellow-300">
                  <p>
                    Your messages are not encrypted. Go to Settings &gt; Encryption to enable end-to-end encryption for better security.
                  </p>
                </div>
                <div className="mt-4">
                  <button
                    onClick={() => {
                      toast.dismiss(t.id);
                      // In a real app, navigate to the encryption settings
                      window.location.hash = '#encryption-settings';
                    }}
                    className="inline-flex items-center px-3 py-1 rounded-lg text-xs font-medium text-yellow-800 dark:text-yellow-200 bg-yellow-50 dark:bg-yellow-800 shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
                  >
                    Enable Encryption
                  </button>
                </div>
              </div>
            </div>
          </div>
        ), {
          id: 'encryption-warning',
          duration: 10000, // Show for 10 seconds
        });
      }
    };

    // Check immediately
    checkEncryptionStatus();

    // Check again when storage changes (in case keys are set in another tab/process)
    const handleStorageChange = () => {
      checkEncryptionStatus();
    };
    
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  return <Toaster position="top-right" />;
};

export default EncryptionStatusNotification;
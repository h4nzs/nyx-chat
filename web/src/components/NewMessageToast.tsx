import { toast, type Toast } from 'react-hot-toast';
import { toAbsoluteUrl } from '@utils/url';

interface NewMessageToastProps {
  t: Toast;
  senderName: string;
  senderAvatar?: string | null;
  message: string;
  conversationId: string;
}

const NewMessageToast = ({ t, senderName, senderAvatar, message, conversationId }: NewMessageToastProps) => {
  // Go to conversation and dismiss toast on click
  const handleClick = () => {
    // Here you would typically navigate to the conversation
    // For now, we just log it and dismiss the toast.
    toast.dismiss(t.id);
  };

  return (
    <div
      className={`
        max-w-md w-full bg-gray-900/80 backdrop-blur-lg shadow-lg rounded-full 
        pointer-events-auto flex ring-1 ring-white/10 transition-all duration-300 ease-in-out
        ${t.visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'}
      `}
      onClick={handleClick}
    >
      <div className="flex items-center p-2 gap-3 w-full cursor-pointer">
        <img
          className="w-10 h-10 rounded-full object-cover bg-gray-700"
          src={toAbsoluteUrl(senderAvatar) || `https://api.dicebear.com/8.x/initials/svg?seed=${senderName}`}
          alt={senderName}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{senderName}</p>
          <p className="text-sm text-gray-400 truncate">{message}</p>
        </div>
      </div>
    </div>
  );
};

export default NewMessageToast;

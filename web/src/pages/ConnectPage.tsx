import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useConversationStore } from '@store/conversation';
import { useModalStore } from '@store/modal';
import { useAuthStore } from '@store/auth';
import { Spinner } from '@components/Spinner';
import toast from 'react-hot-toast';

export default function ConnectPage() {
  const [searchParams] = useSearchParams();
  const u = searchParams.get('u');
  const navigate = useNavigate();
  const searchUsers = useConversationStore(s => s.searchUsers);
  const startConversation = useConversationStore(s => s.startConversation);
  const showConfirm = useModalStore(s => s.showConfirm);
  const me = useAuthStore(s => s.user);
  
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    let active = true;
    
    const processConnection = async () => {
      if (!u || u.length < 10) {
        toast.error("Invalid connection link");
        navigate('/chat');
        return;
      }
      
      try {
        const results = await searchUsers(u);
        if (!active) return;
        
        if (results.length === 0) {
          toast.error("User not found or you are offline.");
          navigate('/chat');
          return;
        }
        
        const targetUser = results[0];
        if (targetUser.id === me?.id) {
          toast.success("This is your own profile!");
          navigate('/chat');
          return;
        }
        
        // Decrypt the profile to show the name
        const { useProfileStore } = await import('@store/profile');
        const decryptedProfile = await useProfileStore.getState().decryptAndCache(targetUser.id, targetUser.encryptedProfile || null);
        
        const targetName = decryptedProfile?.name && decryptedProfile.name !== "Unknown" && decryptedProfile.name !== "Encrypted User" 
            ? decryptedProfile.name 
            : "Encrypted User";
        
        setLoading(false);
        showConfirm(
          "New Secure Connection",
          `Do you want to start a secure conversation with ${targetName}?`,
          async () => {
             try {
                toast.loading(`Connecting to ${targetName}...`, { id: 'connect' });
                const convId = await startConversation(targetUser.id);
                toast.success('Connected!', { id: 'connect' });
                navigate(`/chat/${convId}`);
             } catch (e: any) {
                toast.error(e.message || "Failed to start conversation.", { id: 'connect' });
                navigate('/chat');
             }
          },
          () => {
            // onCancel: return to chat list
            navigate('/chat');
          }
        );
        
      } catch (e) {
        if (!active) return;
        toast.error("Error processing connection link.");
        navigate('/chat');
      }
    };
    
    processConnection();
    
    return () => { active = false; };
  }, [u, navigate, searchUsers, startConversation, showConfirm, me]);
  
  return (
    <div className="min-h-screen bg-bg-main flex items-center justify-center p-4">
      {loading && (
        <div className="text-center">
            <Spinner />
            <p className="mt-4 text-sm text-text-secondary font-mono animate-pulse uppercase tracking-widest">
                Decrypting Profile...
            </p>
        </div>
      )}
    </div>
  );
}

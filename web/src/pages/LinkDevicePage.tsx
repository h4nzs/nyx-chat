import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'react-qr-code';
import { FiRefreshCw, FiCheckCircle, FiXCircle } from 'react-icons/fi';
import { Spinner } from '@components/Spinner';
import { io, Socket } from "socket.io-client";
import { getSodium } from '@lib/sodiumInitializer';
import { v4 as uuidv4 } from 'uuid';
import { useAuthStore } from '@store/auth';
import toast from 'react-hot-toast';
import { worker_crypto_box_seal_open, reEncryptBundleFromMasterKey } from '@lib/crypto-worker-proxy';

const SERVER_URL = import.meta.env.VITE_WS_URL || "http://localhost:4000";

export default function LinkDevicePage() {
  const [qrData, setQrData] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'generating' | 'waiting' | 'linked' | 'failed'>('generating');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    // Create a dedicated, isolated socket connection for this page only.
    const socket: Socket = io(SERVER_URL, { 
      autoConnect: true,
      reconnection: false, // Don't try to reconnect if it fails
    });

    const generateLinkingInfo = async () => {
      setStatus('generating');
      setError(null);
      try {
        const sodium = await getSodium();
        const roomId = uuidv4();
        
        // This is a one-time lightweight operation, acceptable on the main thread.
        const linkingKeys = sodium.crypto_box_keypair();
        const linkingPubKey = sodium.to_base64(linkingKeys.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        const linkingPrivKey = sodium.to_base64(linkingKeys.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        sessionStorage.setItem('linkingPrivKey', linkingPrivKey);
        sessionStorage.setItem('linkingPubKey', linkingPubKey);

        const dataToEncode = JSON.stringify({ roomId, linkingPubKey });
        setQrData(dataToEncode);
        
        console.log(`[Linker] Joining room: ${roomId}`);
        socket.emit('linking:join_room', roomId);
        setStatus('waiting');

        socket.on('linking:receive_payload', async (payload: { encryptedMasterKey: string, linkingToken: string }) => {
          try {
            const linkingPrivKeyB64 = sessionStorage.getItem('linkingPrivKey');
            const linkingPubKeyB64 = sessionStorage.getItem('linkingPubKey');
            if (!linkingPrivKeyB64 || !linkingPubKeyB64) throw new Error('Linking session expired.');

            const sodium = await getSodium();
            
            // Decrypt the master private key using the worker
            const encryptedMasterKeyBytes = sodium.from_base64(payload.encryptedMasterKey, sodium.base64_variants.URLSAFE_NO_PADDING);
            const linkingPubKeyBytes = sodium.from_base64(linkingPubKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
            const linkingPrivKeyBytes = sodium.from_base64(linkingPrivKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
            
            const masterPrivateKey = await worker_crypto_box_seal_open(encryptedMasterKeyBytes, linkingPubKeyBytes, linkingPrivKeyBytes);
            if (!masterPrivateKey) throw new Error("Failed to decrypt master key.");

            // Prompt user for a NEW password for this device
            const { showPasswordPrompt } = (await import('@store/modal')).useModalStore.getState();
            showPasswordPrompt(async (newDevicePassword) => {
              if (!newDevicePassword) {
                setError('Password not provided. Linking canceled.');
                setStatus('failed');
                return;
              }

              try {
                // Re-encrypt the master key with the new password and store it, using the worker
                const {
                  encryptedPrivateKeys,
                  encryptionPublicKeyB64,
                } = await reEncryptBundleFromMasterKey(masterPrivateKey, newDevicePassword);
                
                localStorage.setItem('encryptedPrivateKeys', encryptedPrivateKeys);
                
                // Finalize the linking process with the server
                const { api } = await import('@lib/api');
                await api('/api/auth/finalize-linking', {
                  method: 'POST',
                  body: JSON.stringify({ 
                    linkingToken: payload.linkingToken,
                    publicKey: encryptionPublicKeyB64, // Send the derived public key for verification
                  }),
                });

                // Manually bootstrap the user without needing to hit /api/users/me
                // We can trust the server's response after a successful finalization
                const user = { publicKey: encryptionPublicKeyB64 };
                localStorage.setItem('publicKey', user.publicKey);
                
                toast.success('Device linked successfully! Please log in.');
                setTimeout(() => navigate('/login'), 2000);

              } catch (err: any) {
                console.error("Error during linking finalization:", err);
                setError(err.message || 'Failed to finalize linking.');
                setStatus('failed');
              }
            });
          } catch (decryptionError: any) {
            console.error("Error during linking payload processing:", decryptionError);
            setError(decryptionError.message || 'Failed to process linking payload.');
            setStatus('failed');
          }
        });
      } catch (err: any) {
        setError(err.message || 'Failed to generate linking info.');
        setStatus('failed');
      }
    };

    socket.on('connect', generateLinkingInfo);
    socket.on('connect_error', (err) => {
      setError(`Socket connection failed: ${err.message}`);
      setStatus('failed');
    });

    return () => {
      socket.off('connect');
      socket.off('connect_error');
      socket.off('linking:receive_payload');
      socket.disconnect();
    };
  }, [navigate]);

  const renderStatusMessage = () => {
    const messageClasses = "flex items-center gap-2";
    switch (status) {
      case 'generating':
        return <div className={`${messageClasses} text-text-secondary`}><Spinner size="sm" /> Generating QR Code...</div>;
      case 'waiting':
        return <div className={`${messageClasses} text-text-secondary`}><FiRefreshCw className="animate-spin" /> Waiting for scan...</div>;
      case 'linked':
        return <div className={`${messageClasses} text-green-500`}><FiCheckCircle /> Device Linked! Redirecting...</div>;
      case 'failed':
        return <div className={`${messageClasses} text-red-500`}><FiXCircle /> Linking Failed: {error}</div>;
      default:
        return null;
    }
  };

  return (
    <div className="relative flex flex-col items-center justify-center h-screen bg-bg-main text-text-primary p-4">
      <Link to="/login" aria-label="Go back to login" className="btn btn-secondary p-2 h-10 w-10 rounded-full justify-center absolute top-4 left-4">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
      </Link>
      <div className="bg-bg-surface p-8 rounded-xl shadow-neumorphic-convex text-center max-w-md w-full">
        <h1 className="text-2xl font-bold mb-4">Link a New Device</h1>
        <p className="text-text-secondary mb-6">
          Scan this QR code with an already logged-in device to securely link this new device.
        </p>

        {qrData && status !== 'generating' ? (
          <div className="bg-white p-2 rounded-lg inline-block mb-6">
            <QRCode value={qrData} size={256} level="H" />
          </div>
        ) : (
          <div className="w-64 h-64 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded-lg mb-6">
            <Spinner size="lg" />
          </div>
        )}

        <div className="mb-6 h-6">
          {renderStatusMessage()}
        </div>

        {status !== 'generating' && status !== 'linked' && (
          <Link to="/login" className="text-text-secondary hover:text-text-primary mt-4 block">
            Cancel and Login Manually
          </Link>
        )}
      </div>
    </div>
  );
}

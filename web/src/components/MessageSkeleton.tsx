import { motion } from 'framer-motion';

export default function MessageSkeleton() {
  return (
    <div className="w-full flex flex-col gap-6 p-4 opacity-70">
      {/* Incoming Message Skeleton */}
      <div className="flex items-end gap-3 justify-start">
        <div className="w-8 h-8 rounded-full bg-white/10 animate-pulse flex-shrink-0"></div>
        <div className="flex flex-col gap-1 w-full max-w-[60%]">
           <div className="w-full h-12 rounded-2xl rounded-tl-none bg-white/5 animate-pulse"></div>
           <div className="w-16 h-2 rounded-full bg-white/5 animate-pulse ml-1"></div>
        </div>
      </div>
      
      {/* Outgoing Message Skeleton */}
      <div className="flex items-end gap-3 justify-end">
        <div className="flex flex-col gap-1 items-end w-full max-w-[50%]">
           <div className="w-full h-10 rounded-2xl rounded-tr-none bg-accent/10 animate-pulse"></div>
           <div className="w-12 h-2 rounded-full bg-white/5 animate-pulse mr-1"></div>
        </div>
      </div>

      {/* Incoming Long Message Skeleton */}
      <div className="flex items-end gap-3 justify-start">
        <div className="w-8 h-8 rounded-full bg-white/10 animate-pulse flex-shrink-0"></div>
        <div className="flex flex-col gap-1 w-full max-w-[75%]">
           <div className="w-full h-24 rounded-2xl rounded-tl-none bg-white/5 animate-pulse"></div>
           <div className="w-20 h-2 rounded-full bg-white/5 animate-pulse ml-1"></div>
        </div>
      </div>
      
      {/* Outgoing Short Skeleton */}
      <div className="flex items-end gap-3 justify-end">
        <div className="flex flex-col gap-1 items-end w-full max-w-[30%]">
           <div className="w-full h-10 rounded-2xl rounded-tr-none bg-accent/10 animate-pulse"></div>
        </div>
      </div>
    </div>
  );
}

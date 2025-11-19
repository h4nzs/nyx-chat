import { Link } from 'react-router-dom';
import { FiGithub, FiLock, FiKey, FiSmartphone, FiSun, FiMoon, FiChevronsLeft, FiChevronsRight, FiUserPlus, FiMessageSquare, FiShield } from 'react-icons/fi';
import { motion, useMotionValue, useTransform, useInView } from 'framer-motion';
import { useState, useRef, useEffect, ReactNode } from 'react';

// Animation Variants
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

const AnimatedSection = ({ children }: { children: ReactNode }) => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  return (
    <motion.div
      ref={ref}
      initial="hidden"
      animate={isInView ? "visible" : "hidden"}
      variants={containerVariants}
    >
      {children}
    </motion.div>
  );
};

const FeatureCard = ({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) => (
  <motion.div 
    variants={itemVariants}
    whileHover={{ scale: 1.08, y: -8 }}
    transition={{ type: 'spring', stiffness: 300 }}
    className="bg-bg-surface p-6 rounded-xl shadow-neumorphic-convex text-center cursor-pointer"
  >
    <div className="inline-block p-4 bg-bg-main rounded-full shadow-neumorphic-concave mb-4">
      {icon}
    </div>
    <h3 className="text-xl font-bold text-text-primary mb-2">{title}</h3>
    <p className="text-text-secondary">{children}</p>
  </motion.div>
);

const ThemeComparisonSlider = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    const setInitialPosition = () => {
      if (containerRef.current) {
        const containerWidth = containerRef.current.offsetWidth;
        x.set(containerWidth / 2);
        setIsMounted(true); // Mark as mounted after initial position is set
      }
    };

    // Set initial position after a short delay to ensure layout is stable
    const timer = setTimeout(setInitialPosition, 100);

    const handleResize = () => {
      if (containerRef.current) {
        const containerWidth = containerRef.current.offsetWidth;
        const currentX = x.get();
        // Keep the slider handle at the same relative position
        x.set(Math.max(0, Math.min(currentX, containerWidth)));
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', handleResize);
    };
  }, [x]);

  const lightImageClipPath = useTransform(x, val => `inset(0 calc(100% - ${val}px) 0 0)`);

  return (
    <motion.div
      ref={containerRef}
      className="relative w-full max-w-4xl mx-auto rounded-xl shadow-2xl cursor-ew-resize select-none overflow-hidden"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, delay: 0.3 }}
      style={{ opacity: isMounted ? 1 : 0 }} // Hide until correctly positioned
    >
      {/* Dark mode image (bottom layer) */}
      <img src="/hero-dark.png" alt="Chat Lite dark mode" className="block w-full h-auto object-contain rounded-xl" />

      {/* Light mode image (top layer, clipped) */}
      <motion.div
        className="absolute inset-0 w-full h-full"
        style={{ clipPath: lightImageClipPath }}
      >
        <img src="/hero-light.png" alt="Chat Lite light mode" className="block w-full h-auto object-contain rounded-xl" />
      </motion.div>

      {/* Draggable Handle */}
      <motion.div
        drag="x"
        dragConstraints={containerRef}
        dragElastic={0.1}
        dragMomentum={false}
        style={{ x }}
        className="absolute top-0 bottom-0 w-1.5 bg-white/80 backdrop-blur-sm cursor-ew-resize flex items-center justify-center"
      >
        <div className="w-10 h-10 rounded-full bg-white/80 shadow-lg flex items-center justify-center text-gray-700">
          <FiChevronsLeft />
          <FiChevronsRight />
        </div>
      </motion.div>
    </motion.div>
  );
};

const HowItWorksStep = ({ icon, title, children, isLast }: { icon: React.ReactNode; title: string; children: React.ReactNode; isLast?: boolean; }) => (
  <motion.div variants={itemVariants} className="relative flex flex-col items-center text-center">
    <div className="inline-block p-4 bg-bg-main rounded-full shadow-neumorphic-concave mb-4 z-10">
      {icon}
    </div>
    <h3 className="text-xl font-bold text-text-primary mb-2">{title}</h3>
    <p className="text-text-secondary max-w-xs">{children}</p>
    {!isLast && (
      <div className="absolute top-9 left-1/2 w-full h-0.5 bg-border hidden md:block" />
    )}
  </motion.div>
);

const TestimonialCard = ({ children, author, role }: { children: ReactNode; author: string; role: string; }) => (
  <motion.div variants={itemVariants} className="bg-bg-surface p-8 rounded-xl shadow-neumorphic-convex">
    <p className="text-lg italic text-text-primary mb-4">"{children}"</p>
    <p className="font-bold text-accent">{author}</p>
    <p className="text-sm text-text-secondary">{role}</p>
  </motion.div>
);

export default function LandingPage() {
  return (
    <div className="bg-bg-main min-h-screen font-sans text-text-primary overflow-y-auto relative">
      {/* Decorative Gradient */}
      <div 
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[150%] h-[800px] bg-radial-gradient from-accent/10 to-transparent pointer-events-none"
        style={{
          background: 'radial-gradient(circle, hsl(var(--accent) / 0.05) 0%, transparent 60%)'
        }}
      />
      
      <div className="relative z-10">
        {/* Header */}
        <motion.header 
          initial="hidden" 
          animate="visible" 
          variants={containerVariants} 
          className="p-4 flex justify-between items-center max-w-6xl mx-auto"
        >
          <motion.h1 variants={itemVariants} className="text-2xl font-bold">Chat Lite</motion.h1>
          <motion.div variants={itemVariants}>
            <Link to="/login" className="btn btn-secondary">
              Login
            </Link>
          </motion.div>
        </motion.header>

        {/* Hero Section */}
        <main className="max-w-6xl mx-auto px-4 py-16 md:py-24 text-center">
          <motion.div initial="hidden" animate="visible" variants={containerVariants}>
            <motion.h1 variants={itemVariants} className="text-4xl md:text-6xl font-extrabold tracking-tight mb-4">
              Private Conversations, <span className="text-accent">Secured by You.</span>
            </motion.h1>
            <motion.p variants={itemVariants} className="text-lg md:text-xl text-text-secondary max-w-3xl mx-auto mb-8">
              An end-to-end encrypted chat application with a focus on privacy, user control, and a beautiful, modern interface.
            </motion.p>
            <motion.div variants={itemVariants} className="flex justify-center items-center gap-4">
              <Link to="/register" className="btn btn-primary text-lg px-8 py-3">
                Get Started
              </Link>
              <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="btn btn-secondary text-lg px-8 py-3">
                <FiGithub className="mr-2" />
                View on GitHub
              </a>
            </motion.div>
          </motion.div>

          <div className="mt-16 md:mt-24">
            <ThemeComparisonSlider />
          </div>
        </main>

        {/* Why Chat Lite Section */}
        <section className="py-16 md:py-24">
          <AnimatedSection>
            <div className="max-w-4xl mx-auto px-4 text-center">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-bold mb-6">Why Chat Lite?</motion.h2>
              <motion.p variants={itemVariants} className="text-lg md:text-xl text-text-secondary mb-4">
                Tired of complicated sign-ups and mandatory app downloads? Chat Lite is your solution. Access it instantly from your favorite browser—no installation needed.
              </motion.p>
              <motion.p variants={itemVariants} className="text-lg md:text-xl text-text-secondary">
                Worried about your data? We are too. Chat Lite is built on a foundation of privacy, acting only as a secure bridge between you and your contacts. Your data is yours, and yours alone.
              </motion.p>
            </div>
          </AnimatedSection>
        </section>

        {/* Features Section */}
        <section className="py-16 md:py-24 bg-bg-surface">
          <AnimatedSection>
            <div className="max-w-6xl mx-auto px-4">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-bold text-center mb-12">Features Built for You</motion.h2>
              <motion.div variants={containerVariants} className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
                <FeatureCard icon={<FiLock size={24} className="text-accent" />} title="End-to-End Encryption">
                  Your messages are sealed. Only you and the recipient can read them, powered by the Double Ratchet algorithm.
                </FeatureCard>
                <FeatureCard icon={<FiKey size={24} className="text-accent" />} title="User-Controlled Keys">
                  You own your keys. Restore your account on any device with your unique 24-word recovery phrase.
                </FeatureCard>
                <FeatureCard icon={<FiSmartphone size={24} className="text-accent" />} title="Seamless Device Linking">
                  Securely link new devices using a simple QR code, without ever needing to re-enter your password.
                </FeatureCard>
                <FeatureCard icon={<div className="flex gap-2"><FiSun size={24} className="text-accent" /><FiMoon size={24} className="text-accent" /></div>} title="Modern, Themed UI">
                  A beautiful, fully-themed interface with light and dark modes, built with a tactile Neumorphic design.
                </FeatureCard>
              </motion.div>
            </div>
          </AnimatedSection>
        </section>
        
        {/* More Visuals Section */}
        <section className="py-16 md:py-24">
          <AnimatedSection>
            <div className="max-w-6xl mx-auto px-4 grid md:grid-cols-2 gap-8 items-center">
              <motion.div variants={itemVariants} className="text-center md:text-left">
                <h2 className="text-3xl md:text-4xl font-bold mb-4">Works Everywhere</h2>
                <p className="text-lg text-text-secondary">Enjoy a consistent experience whether you're on your desktop or on the go, with a fully responsive design that adapts to your screen.</p>
              </motion.div>
              <div className="grid grid-cols-2 gap-4 items-start">
                <motion.img 
                  initial={{ opacity: 0, scale: 0.9, rotate: 2 }}
                  whileInView={{ opacity: 1, scale: 1, rotate: 2 }}
                  viewport={{ once: true, amount: 0.5 }}
                  transition={{ duration: 0.5, delay: 0.1 }}
                  src="/normal-desktop-dark.png" 
                  alt="Desktop view" 
                  className="rounded-lg shadow-xl z-10"
                />
                <motion.img 
                  initial={{ opacity: 0, scale: 0.9, rotate: -4, y: 16 }}
                  whileInView={{ opacity: 1, scale: 1, rotate: -4, y: 16 }}
                  viewport={{ once: true, amount: 0.5 }}
                  transition={{ duration: 0.5, delay: 0.2 }}
                  src="/tablet-dark.png" 
                  alt="Tablet dark mode" 
                  className="rounded-lg shadow-xl"
                />
                <motion.img 
                  initial={{ opacity: 0, scale: 0.9, rotate: -3, y: -16 }}
                  whileInView={{ opacity: 1, scale: 1, rotate: -3, y: -16 }}
                  viewport={{ once: true, amount: 0.5 }}
                  transition={{ duration: 0.5, delay: 0.3 }}
                  src="/tablet-light-show-sidebar.png" 
                  alt="Tablet light mode with sidebar" 
                  className="rounded-lg shadow-xl z-10"
                />
                <motion.img 
                  initial={{ opacity: 0, scale: 0.9, rotate: 5, y: 16 }}
                  whileInView={{ opacity: 1, scale: 1, rotate: 5, y: 16 }}
                  viewport={{ once: true, amount: 0.5 }}
                  transition={{ duration: 0.5, delay: 0.4 }}
                  src="/mobile-light.png" 
                  alt="Mobile view" 
                  className="rounded-lg shadow-xl"
                />
              </div>
            </div>
          </AnimatedSection>
        </section>

        {/* How It Works Section */}
        <section className="py-16 md:py-24 bg-bg-surface">
          <AnimatedSection>
            <div className="max-w-6xl mx-auto px-4">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-bold text-center mb-16">Simple, Secure, Transparent.</motion.h2>
              <motion.div variants={containerVariants} className="relative grid md:grid-cols-3 gap-12">
                <HowItWorksStep icon={<FiUserPlus size={24} className="text-accent" />} title="1. Create Your Account">
                  Sign up and automatically generate your unique, private encryption keys.
                </HowItWorksStep>
                <HowItWorksStep icon={<FiMessageSquare size={24} className="text-accent" />} title="2. Start a Conversation">
                  Your messages are end-to-end encrypted from the very first word.
                </HowItWorksStep>
                <HowItWorksStep icon={<FiShield size={24} className="text-accent" />} title="3. Verify Your Contacts" isLast>
                  Use Safety Numbers to ensure you're talking to the right person, free from man-in-the-middle attacks.
                </HowItWorksStep>
              </motion.div>
            </div>
          </AnimatedSection>
        </section>

        {/* Testimonials Section */}
        <section className="py-16 md:py-24">
          <AnimatedSection>
            <div className="max-w-4xl mx-auto px-4">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-bold text-center mb-12">Trusted by Teams Who Value Privacy</motion.h2>
              <motion.div variants={containerVariants} className="grid md:grid-cols-2 gap-8">
                <TestimonialCard author="Yosep." role="Privacy Advocate">
                  Finally, a chat app that respects my privacy without sacrificing a beautiful user experience. The fact that I control my own keys is a game-changer.
                </TestimonialCard>
                <TestimonialCard author="Sarah T." role="Remote Team Lead">
                  Chat Lite has become essential for our team. It's simple, secure, and the interface is just a pleasure to use every day.
                </TestimonialCard>
              </motion.div>
            </div>
          </AnimatedSection>
        </section>

        {/* Footer */}
        <footer className="bg-bg-surface py-8">
          <div className="max-w-6xl mx-auto px-4 text-center text-text-secondary">
            <p>&copy; {new Date().getFullYear()} Chat Lite. Built with ❤️.</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
import { Link } from 'react-router-dom';
import { 
  FiGithub, FiLock, FiKey, FiSmartphone, FiSun, FiMoon, 
  FiChevronsLeft, FiChevronsRight, FiUserPlus, FiMessageSquare, 
  FiShield, FiArrowRight, FiHash, FiEyeOff, FiCheck, FiX, FiCpu 
} from 'react-icons/fi';
import { motion, useMotionValue, useTransform, useInView } from 'framer-motion';
import { useState, useRef, useEffect, ReactNode } from 'react';
import { useThemeStore } from '@store/theme';

// --- Animation Variants ---
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

// --- Reusable Components ---
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

// Chiseled Depth Feature Card with Mass Physics (Original Style)
const FeatureCard = ({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) => (
  <motion.div
    variants={itemVariants}
    whileHover={{
      scale: 0.98,
      y: 4,
      transition: {
        type: 'spring',
        stiffness: 500,
        damping: 20,
        mass: 2
      }
    }}
    whileTap={{
      scale: 0.95,
      transition: {
        type: 'spring',
        stiffness: 800,
        damping: 25,
        mass: 3
      }
    }}
    className="
      bg-bg-main p-8 rounded-2xl
      shadow-neu-flat dark:shadow-neu-flat-dark
      hover:shadow-neu-pressed dark:hover:shadow-neu-pressed-dark
      hover:scale-[0.98]
      transition-all duration-300
      border border-white/50 dark:border-white/5
      text-center cursor-pointer
      h-full flex flex-col items-center justify-start
    "
  >
    <div className="inline-block p-4 bg-bg-main rounded-full shadow-[4px_4px_8px_rgba(0,0,0,0.2),-4px_-4px_8px_rgba(255,255,255,0.1)] mb-4 text-accent">
      {icon}
    </div>
    <h3 className="text-xl font-bold text-text-primary mb-2">{title}</h3>
    <p className="text-text-secondary leading-relaxed">{children}</p>
  </motion.div>
);

const HowItWorksStep = ({ icon, title, children, isLast }: { icon: React.ReactNode; title: string; children: React.ReactNode; isLast?: boolean; }) => (
  <motion.div variants={itemVariants} className="relative flex flex-col items-center text-center">
    <div className="inline-block p-4 bg-bg-main rounded-full shadow-[4px_4px_8px_rgba(0,0,0,0.2),-4px_-4px_8px_rgba(255,255,255,0.1)] mb-4 z-10 text-accent">
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
  <motion.div variants={itemVariants} className="bg-bg-surface p-8 rounded-lg shadow-[8px_8px_16px_rgba(0,0,0,0.2),-8px_-8px_16px_rgba(255,255,255,0.1)] border border-transparent hover:border-accent/30 transition-all duration-300"
    style={{
      backgroundImage: 'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.1) 0%, transparent 40%), radial-gradient(circle at 80% 80%, rgba(0,0,0,0.1) 0%, transparent 40%)',
      backgroundBlendMode: 'overlay'
    }}>
    <p className="text-lg italic text-text-primary mb-4">"{children}"</p>
    <p className="font-bold text-accent">{author}</p>
    <p className="text-sm text-text-secondary">{role}</p>
  </motion.div>
);

const FAQSection = () => (
  <section className="py-16 md:py-24">
    <AnimatedSection>
      <div className="max-w-3xl mx-auto px-4">
        <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black text-center mb-12 tracking-tighter">FREQUENTLY ASKED QUESTIONS</motion.h2>
        <div className="space-y-4">
          {[
            { q: "Is NYX end-to-end encrypted?", a: "Yes. We use the Signal Protocol (Double Ratchet Algorithm) to ensure that only you and the person you're communicating with can read what's sent. Not even the server can decrypt your messages." },
            { q: "Do I need to install an app?", a: "No. NYX is a Progressive Web App (PWA). You can use it directly in your browser or install it to your home screen for a native-like experience without the app store friction." },
            { q: "Is it completely free?", a: "Yes, NYX is open-source and free to use. There are no hidden fees, ads, or data tracking." },
            { q: "How do I recover my account?", a: "When you sign up, you receive a 24-word recovery phrase. This is the ONLY way to restore your account, but remember that you cannot access your messages history. And we do not store this phrase." }
          ].map((item, i) => (
            <motion.div variants={itemVariants} key={i} className="bg-bg-surface rounded-lg shadow-[4px_4px_8px_rgba(0,0,0,0.1),-4px_-4px_8px_rgba(255,255,255,0.05)] overflow-hidden">
              <details className="group">
                <summary className="flex justify-between items-center font-bold cursor-pointer list-none p-6 text-text-primary hover:text-accent transition-colors">
                  <span>{item.q}</span>
                  <span className="transition group-open:rotate-180">
                    <svg fill="none" height="24" shapeRendering="geometricPrecision" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24" width="24"><path d="M6 9l6 6 6-6"></path></svg>
                  </span>
                </summary>
                <div className="text-text-secondary px-6 pb-6 pt-0 leading-relaxed">
                  {item.a}
                </div>
              </details>
            </motion.div>
          ))}
        </div>
      </div>
    </AnimatedSection>
  </section>
);

// New Comparison Data
const comparisonData = [
  { feature: "Phone No. Required?", wa: "Yes", tg: "Yes", nyx: "NO", isWin: true },
  { feature: "App Install?", wa: "Required", tg: "Required", nyx: "Optional (PWA)", isWin: true },
  { feature: "E2E Encryption", wa: "Default", tg: "Secret Chat Only", nyx: "Always On", isWin: true },
  { feature: "Local Footprint", wa: "SQL Database", tg: "Cloud Cache", nyx: "ZERO (Browser)", isWin: true },
];

export default function LandingPage() {
  const { theme } = useThemeStore();
  const [grainOpacity, setGrainOpacity] = useState(0.05);

  useEffect(() => {
    setGrainOpacity(theme === 'dark' ? 0.08 : 0.05);
  }, [theme]);

  // Pilih screenshot berdasarkan tema (opsional) atau fix ke dark
  const heroScreenshot = theme === 'dark' ? '/screenshots/mobile-dark.png' : '/screenshots/mobile-light.png';

  return (
    <div
      className="min-h-screen font-sans text-text-primary overflow-y-auto relative"
      style={{
        backgroundColor: theme === 'dark' ? '#1a1a1a' : '#f5f0e6',
        backgroundImage: `radial-gradient(circle at 10% 20%, rgba(255,255,255,${grainOpacity}), transparent 20%),
                          radial-gradient(circle at 90% 80%, rgba(0,0,0,${grainOpacity * 0.8}), transparent 20%)`,
      }}
    >
      {/* Grain texture overlay */}
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background: `url("data:image/svg+xml,%3Csvg viewBox='0 0 250 250' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.1'/%3E%3C/svg%3E")`,
          opacity: theme === 'dark' ? 0.15 : 0.1,
        }}
      ></div>

      <div className="relative z-10">
        {/* Header */}
        <motion.header
          initial="hidden"
          animate="visible"
          variants={containerVariants}
          className="p-4 flex justify-between items-center max-w-6xl mx-auto"
        >
          <motion.div variants={itemVariants} className="flex items-center">
            <img src="/pwa-512x512.png" alt="NYX Logo" className="w-8 h-8 mr-2" />
            <span className="text-2xl font-bold tracking-tighter">NYX</span>
          </motion.div>
          <motion.div variants={itemVariants}>
            <Link to="/login" className="px-4 py-2 rounded-lg bg-bg-surface text-text-primary shadow-[3px_3px_6px_rgba(0,0,0,0.2),-3px_-3px_6px_rgba(255,255,255,0.1)] hover:shadow-[inset_1px_1px_3px_rgba(0,0,0,0.2)] transition-all">
              Login
            </Link>
          </motion.div>
        </motion.header>

        {/* Hero Section */}
        <main className="max-w-6xl mx-auto px-4 py-16 md:py-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
            <div className="lg:col-span-7">
              <motion.div initial="hidden" animate="visible" variants={containerVariants}>
                <motion.div variants={itemVariants} className="inline-block mb-4 px-4 py-1 rounded-full bg-bg-main shadow-[inset_2px_2px_5px_rgba(0,0,0,0.2),inset_-2px_-2px_5px_rgba(255,255,255,0.1)] text-accent text-xs md:text-sm font-bold tracking-wider uppercase">
                  v1.0 • E2EE Encrypted • Anonymous
                </motion.div>
                <motion.h1 variants={itemVariants} className="text-5xl md:text-7xl font-black tracking-tighter leading-none mb-6">
                  PRIVATE<br />
                  <span className="text-accent" style={{ textShadow: '2px 2px 4px rgba(255, 107, 53, 0.3)' }}>CONVERSATIONS</span><br />
                  SECURED BY YOU
                </motion.h1>
                <motion.p variants={itemVariants} className="text-lg md:text-xl text-text-secondary max-w-xl mb-8 leading-relaxed">
                  End-to-end encrypted messaging with a tactile, industrial design. 
                  No phone numbers. No trackers. Just you and your data.
                </motion.p>
                <motion.div variants={itemVariants} className="flex flex-col sm:flex-row justify-start items-start gap-4">
                  <Link to="/register" className="px-8 py-4 rounded-lg bg-accent text-white font-bold shadow-[5px_5px_10px_rgba(0,0,0,0.3),-5px_-5px_10px_rgba(255,255,255,0.1)] hover:shadow-[inset_2px_2px_5px_rgba(0,0,0,0.3)] transition-all flex items-center">
                    GET STARTED <FiArrowRight className="ml-2" />
                  </Link>
                  <a href="https://github.com/h4nzs/chat-lite" target="_blank" rel="noopener noreferrer" className="px-8 py-4 rounded-lg bg-bg-surface text-text-primary shadow-[3px_3px_6px_rgba(0,0,0,0.2),-3px_-3px_6px_rgba(255,255,255,0.1)] hover:shadow-[inset_1px_1px_3px_rgba(0,0,0,0.2)] transition-all flex items-center">
                    <FiGithub className="mr-2" />
                    SOURCE CODE
                  </a>
                </motion.div>
              </motion.div>
            </div>

            {/* Visual Mockup (UPDATED: Mobile Aspect Ratio) */}
            <div className="lg:col-span-5 flex justify-center lg:justify-end">
               <motion.div 
                 initial={{ opacity: 0, x: 20 }}
                 animate={{ opacity: 1, x: 0 }}
                 transition={{ delay: 0.5, duration: 0.8 }}
                 // Lebar disesuaikan agar proporsional sebagai HP
                 className="relative w-full max-w-[280px] md:max-w-[320px]"
               >
                  {/* CSS-Only Phone Frame (Corrected for Mobile 9:19 Ratio) */}
                  <div className="relative mx-auto border-gray-800 dark:border-gray-900 bg-gray-900 border-[10px] rounded-[2.5rem] shadow-[20px_20px_40px_rgba(0,0,0,0.4),-10px_-10px_30px_rgba(255,255,255,0.05)] overflow-hidden">
                      {/* Buttons */}
                      <div className="h-[32px] w-[3px] bg-gray-800 absolute -start-[13px] top-[72px] rounded-s-lg"></div>
                      <div className="h-[46px] w-[3px] bg-gray-800 absolute -start-[13px] top-[124px] rounded-s-lg"></div>
                      <div className="h-[46px] w-[3px] bg-gray-800 absolute -start-[13px] top-[178px] rounded-s-lg"></div>
                      <div className="h-[64px] w-[3px] bg-gray-800 absolute -end-[13px] top-[142px] rounded-e-lg"></div>
                      
                      {/* Screen Container: Gunakan Aspect Ratio agar tidak gepeng/kepotong */}
                      <div className="rounded-[2rem] overflow-hidden w-full h-auto aspect-[9/19] bg-bg-main relative">
                          <img 
                            src={heroScreenshot} 
                            alt="App Screenshot" 
                            className="object-cover object-top w-full h-full opacity-90 hover:scale-105 transition-transform duration-700" 
                          />
                          <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-bg-main via-transparent to-transparent opacity-20"></div>
                      </div>
                  </div>
               </motion.div>
            </div>
          </div>
        </main>

        {/* "Why NYX" Section */}
        <section className="py-16 md:py-24 bg-bg-main/50 backdrop-blur-sm">
          <AnimatedSection>
            <div className="max-w-4xl mx-auto px-4 text-center">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black mb-6 tracking-tighter">WHY NYX?</motion.h2>
              <motion.p variants={itemVariants} className="text-lg md:text-xl text-text-secondary mb-4">
                Tired of complicated sign-ups and mandatory app downloads? NYX is your solution. Access it instantly from your favorite browser—no installation needed.
              </motion.p>
              <motion.p variants={itemVariants} className="text-lg md:text-xl text-text-secondary">
                Worried about your data? We are too. NYX is built on a foundation of privacy, acting only as a secure bridge between you and your contacts.
              </motion.p>
            </div>
          </AnimatedSection>
        </section>

        {/* COMPARISON TABLE (New Section) */}
        <section className="py-16 md:py-24">
          <AnimatedSection>
            <div className="max-w-5xl mx-auto px-4">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black text-center mb-12 tracking-tighter">NYX vs. THE GIANTS</motion.h2>
              
              <div className="bg-bg-surface rounded-3xl p-6 md:p-8 shadow-[inset_3px_3px_6px_rgba(0,0,0,0.2),inset_-3px_-3px_6px_rgba(255,255,255,0.05)] overflow-x-auto">
                <table className="w-full min-w-[600px] border-separate border-spacing-y-4">
                  <thead>
                    <tr className="text-text-secondary text-sm uppercase tracking-wider">
                      <th className="text-left py-4 px-6">Feature</th>
                      <th className="py-4 px-4 font-normal">WhatsApp</th>
                      <th className="py-4 px-4 font-normal">Telegram</th>
                      <th className="py-4 px-6 text-accent font-black text-lg">NYX</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonData.map((row, idx) => (
                      <motion.tr key={idx} variants={itemVariants} className="group">
                        <td className="py-4 px-6 font-bold text-text-primary bg-bg-main rounded-l-xl shadow-[2px_2px_5px_rgba(0,0,0,0.1)] border-r border-transparent">
                          {row.feature}
                        </td>
                        <td className="py-4 px-4 text-center text-red-500 bg-bg-main/50">
                          <div className="flex items-center justify-center gap-2">
                            {row.wa === "Yes" || row.wa === "Required" ? <FiX/> : null} {row.wa}
                          </div>
                        </td>
                        <td className="py-4 px-4 text-center text-yellow-500 bg-bg-main/50">
                          {row.tg}
                        </td>
                        <td className="py-4 px-6 text-center text-green-500 font-bold bg-bg-main rounded-r-xl shadow-[inset_-2px_2px_5px_rgba(0,0,0,0.1)]">
                          <div className="flex items-center justify-center gap-2">
                            <FiCheck className="text-xl" /> {row.nyx}
                          </div>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </AnimatedSection>
        </section>

        {/* Features Section (Merged) */}
        <section className="py-16 md:py-24" style={{ backgroundColor: theme === 'dark' ? '#222222' : '#e8e2d5' }}>
          <AnimatedSection>
            <div className="max-w-6xl mx-auto px-4">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black text-center mb-12 tracking-tighter">FEATURES BUILT FOR PRIVACY</motion.h2>
              <motion.div variants={containerVariants} className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
                
                {/* New Feature: No Phone Number */}
                <FeatureCard icon={<FiHash size={24} />} title="NO PHONE NUMBER">
                  Sign up with just a Username. Your real identity stays safe. No one can 'save your contact' without permission.
                </FeatureCard>

                {/* New Feature: Ghost App */}
                <FeatureCard icon={<FiEyeOff size={24} />} title="GHOST APP (PWA)">
                  Zero install. Open in browser, chat, close tab, and clear data. Zero forensic footprint left on your device.
                </FeatureCard>

                {/* New Feature: Argon2 */}
                <FeatureCard icon={<FiCpu size={24} />} title="ARGON2 SECURITY">
                  The only web chat that turns your password into a military-grade encryption key using memory-hardened hashing.
                </FeatureCard>

                {/* Old Feature: Neumorphism (Keep this as it's a design selling point) */}
                <FeatureCard icon={<div className="flex gap-2"><FiSun size={24} /><FiMoon size={24} /></div>} title="TACTILE DESIGN">
                  A mutated neumorphic interface with chiseled depth and grain texture for a premium physical feel.
                </FeatureCard>

              </motion.div>
            </div>
          </AnimatedSection>
        </section>

        {/* How It Works Section */}
        <section className="py-16 md:py-24">
          <AnimatedSection>
            <div className="max-w-6xl mx-auto px-4">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black text-center mb-16 tracking-tighter">SIMPLE, SECURE, TRANSPARENT.</motion.h2>
              <motion.div variants={containerVariants} className="relative grid md:grid-cols-3 gap-12">
                <HowItWorksStep icon={<FiUserPlus size={24} />} title="1. CREATE ACCOUNT">
                  Sign up via username. We automatically generate your 24-word recovery phrase for encryption.
                </HowItWorksStep>
                <HowItWorksStep icon={<FiMessageSquare size={24} />} title="2. START CHATTING">
                  Your messages are end-to-end encrypted from the very first word using the Signal Protocol.
                </HowItWorksStep>
                <HowItWorksStep icon={<FiShield size={24} />} title="3. VANISH">
                  Done? Close the browser. Encryption keys are wiped from memory. No trace left behind.
                </HowItWorksStep>
              </motion.div>
            </div>
          </AnimatedSection>
        </section>

        {/* Testimonials Section */}
        <section className="py-16 md:py-24" style={{ backgroundColor: theme === 'dark' ? '#222222' : '#e8e2d5' }}>
          <AnimatedSection>
            <div className="max-w-4xl mx-auto px-4">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black text-center mb-12 tracking-tighter">TRUSTED BY PRIVACY ADVOCATES</motion.h2>
              <motion.div variants={containerVariants} className="grid md:grid-cols-2 gap-8">
                <TestimonialCard author="Yosep." role="Privacy Advocate">
                  Finally, a chat app that respects my privacy without sacrificing a beautiful user experience. The fact that I control my own keys is a game-changer.
                </TestimonialCard>
                <TestimonialCard author="Sarah T." role="Remote Team Lead">
                  Nyx has become essential for our team. It's simple, secure, and a pleasure to use every day.
                </TestimonialCard>
              </motion.div>
            </div>
          </AnimatedSection>
        </section>

        {/* FAQ Section */}
        <FAQSection />

        {/* Final CTA Section */}
        <section className="py-16 md:py-24">
          <AnimatedSection>
            <div className="max-w-4xl mx-auto px-4 text-center">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black mb-6 tracking-tighter">TAKE BACK YOUR PRIVACY.</motion.h2>
              <motion.p variants={itemVariants} className="text-lg text-text-secondary mb-8 max-w-2xl mx-auto">
                Don't let your data become a commodity. Switch to NYX today. Free, Open Source, Forever.
              </motion.p>
              <motion.div variants={itemVariants}>
                <Link to="/register" className="px-8 py-4 rounded-lg bg-accent text-white font-bold shadow-[5px_5px_10px_rgba(0,0,0,0.3),-5px_-5px_10px_rgba(255,255,255,0.1)] hover:shadow-[inset_2px_2px_5px_rgba(0,0,0,0.3)] transition-all inline-flex items-center">
                  CREATE ANONYMOUS ACCOUNT <FiArrowRight className="ml-2" />
                </Link>
              </motion.div>
            </div>
          </AnimatedSection>
        </section>

        {/* Footer */}
        <footer className="py-8">
          <div className="max-w-6xl mx-auto px-4 text-center text-text-secondary">
            <div className="flex justify-center items-center mb-2">
              <img
                src="/pwa-512x512.png"
                alt="NYX Logo"
                className="w-6 h-6 mr-2"
              />
              <p className="text-sm mt-4">&copy; {new Date().getFullYear()} NYX Project. Open Source (MIT).</p>
              {/* TAMBAHAN DISCLAIMER HUKUM */}
              <p className="text-xs text-text-secondary/50 mt-8 max-w-2xl mx-auto">
              WhatsApp is a registered trademark of Meta Platforms, Inc. Telegram is a registered trademark of Telegram FZ-LLC. 
              NYX is an independent open-source project and is not affiliated with, endorsed by, or sponsored by these companies.
              Comparisons are made for informational purposes based on public technical documentation available as of {new Date().getFullYear()}.
              </p>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
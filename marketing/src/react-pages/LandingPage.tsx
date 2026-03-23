// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
import { 
  FiGithub, FiSun, FiMoon, 
  FiUserPlus, FiMessageSquare, 
  FiShield, FiArrowRight, FiHash, FiEyeOff, FiCheck, FiX, FiCpu 
} from 'react-icons/fi';
import { motion, useInView } from 'framer-motion';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { useThemeStore } from '@store/theme';
import { useShallow } from 'zustand/react/shallow';
import SEO from '../components/SEO';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../components/LanguageSwitcher';

// --- URL APP UTAMA ---
const APP_URL = "https://app.nyx-app.my.id";

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
    <p className="text-lg italic text-text-primary mb-4">&quot;{children}&quot;</p>
    <p className="font-bold text-accent">{author}</p>
    <p className="text-sm text-text-secondary">{role}</p>
  </motion.div>
);

const FAQSection = () => {
  const { t } = useTranslation('landing');
  return (
    <section className="py-16 md:py-24">
      <AnimatedSection>
        <div className="max-w-3xl mx-auto px-4">
          <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black text-center mb-12 tracking-tighter">
            {t('faq.title')}
          </motion.h2>
          <div className="space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <motion.div variants={itemVariants} key={i} className="bg-bg-surface rounded-lg shadow-[4px_4px_8px_rgba(0,0,0,0.1),-4px_-4px_8px_rgba(255,255,255,0.05)] overflow-hidden">
                <details className="group">
                  <summary className="flex justify-between items-center font-bold cursor-pointer list-none p-6 text-text-primary hover:text-accent transition-colors">
                    <span>{t(`faq.q${i}`)}</span>
                    <span className="transition group-open:rotate-180">
                      <svg fill="none" height="24" shapeRendering="geometricPrecision" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24" width="24"><path d="M6 9l6 6 6-6"></path></svg>
                    </span>
                  </summary>
                  <div className="text-text-secondary px-6 pb-6 pt-0 leading-relaxed">
                    {t(`faq.a${i}`)}
                  </div>
                </details>
              </motion.div>
            ))}
          </div>
        </div>
      </AnimatedSection>
    </section>
  );
};

export default function LandingPage() {
  const { t } = useTranslation(['landing', 'common']);
  const { theme } = useThemeStore(useShallow(s => ({ theme: s.theme })));
  
  // ✅ HITUNG LANGSUNG SAAT RENDER (Tanpa Effect & State)
  const grainOpacity = theme === 'dark' ? 0.08 : 0.05;

  // Pilih screenshot berdasarkan tema
  const heroScreenshot = theme === 'dark' ? '/screenshots/mobile-dark.png' : '/screenshots/mobile-light.png';

  const comparisonData = [
    { feature: t('landing:comparison.rows.phone_required'), wa: t('landing:comparison.values.yes'), tg: t('landing:comparison.values.yes'), nyx: t('landing:comparison.values.no'), isWin: true },
    { feature: t('landing:comparison.rows.app_install'), wa: t('landing:comparison.values.required'), tg: t('landing:comparison.values.required'), nyx: t('landing:comparison.values.optional'), isWin: true },
    { feature: t('landing:comparison.rows.e2e'), wa: t('landing:comparison.values.default'), tg: t('landing:comparison.values.secret_only'), nyx: t('landing:comparison.values.always_on'), isWin: true },
    { feature: t('landing:comparison.rows.footprint'), wa: t('landing:comparison.values.sql_db'), tg: t('landing:comparison.values.cloud_cache'), nyx: t('landing:comparison.values.zero'), isWin: true },
  ];

  const landingSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "name": "NYX Chat",
        "applicationCategory": "CommunicationApplication",
        "operatingSystem": "Web, Android, iOS, Windows, macOS, Linux",
        "offers": {
          "@type": "Offer",
          "price": "0",
          "priceCurrency": "USD"
        },
        "description": t('landing:hero.description'),
        "featureList": [
          t('landing:features.no_phone.title'),
          t('landing:schema.e2ee', 'End-to-End Encryption (Signal Protocol)'),
          t('landing:schema.self_destruct', 'Self-Destructing Messages'),
          t('landing:schema.local_first', 'Local-First Architecture'),
          t('landing:features.ghost_app.title')
        ],
        "softwareHelp": "https://nyx-app.my.id/help",
        "author": {
          "@type": "Person",
          "name": "Han",
          "url": "https://github.com/h4nzs"
        }
      },
      {
        "@type": "FAQPage",
        "mainEntity": [
          {
            "@type": "Question",
            "name": t('landing:faq.q1'),
            "acceptedAnswer": {
              "@type": "Answer",
              "text": t('landing:faq.a1')
            }
          },
          {
            "@type": "Question",
            "name": t('landing:faq.q2'),
            "acceptedAnswer": {
              "@type": "Answer",
              "text": t('landing:faq.a2')
            }
          },
          {
            "@type": "Question",
            "name": t('landing:faq.q3'),
            "acceptedAnswer": {
              "@type": "Answer",
              "text": t('landing:faq.a3')
            }
          }
        ]
      }
    ]
  });

  return (
    <div
      className="min-h-screen font-sans text-text-primary overflow-y-auto relative"
      style={{
        backgroundColor: theme === 'dark' ? '#1a1a1a' : '#f5f0e6',
        backgroundImage: `radial-gradient(circle at 10% 20%, rgba(255,255,255,${grainOpacity}), transparent 20%),
                          radial-gradient(circle at 90% 80%, rgba(0,0,0,${grainOpacity * 0.8}), transparent 20%)`,
      }}
    >
      <SEO 
        title="NYX" 
        description={t('landing:hero.description')}
        canonicalUrl="/" 
        schemaMarkup={landingSchema}
      />
      
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
           className="p-4 flex justify-between items-center max-w-6xl mx-auto relative"
        >
          {/* KIRI: Logo */}
          <motion.div variants={itemVariants} className="flex items-center">
            <img src="/pwa-512x512.png" alt="NYX Logo" className="w-8 h-8 mr-2" />
            <span className="text-2xl font-bold tracking-tighter">NYX</span>
          </motion.div>

          {/* KANAN: Grouping Login + Language */}
          <motion.div variants={itemVariants} className="flex items-center gap-4">
            {/* PERBAIKAN 1: Link menjadi tag <a> */}
            <a 
              href={`${APP_URL}/login`}
              className="px-4 py-2 rounded-lg bg-bg-surface text-text-primary shadow-[3px_3px_6px_rgba(0,0,0,0.2),-3px_-3px_6px_rgba(255,255,255,0.1)] hover:shadow-[inset_1px_1px_3px_rgba(0,0,0,0.2)] transition-all"
            >
              {t('landing:header.login')}
            </a>

            {/* Bungkus Switcher agar tidak absolute keluar jalur */}
            <div className="relative"> 
               <LanguageSwitcher />
            </div>
          </motion.div>
        </motion.header>

        {/* Hero Section */}
        <main className="max-w-6xl mx-auto px-4 py-16 md:py-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
            <div className="lg:col-span-7">
              <motion.div initial="hidden" animate="visible" variants={containerVariants}>
                {/* Catatan: Pastikan __APP_VERSION__ di-define di vite-env.d.ts dan vite.config.ts folder marketing Anda */}
                <motion.div variants={itemVariants} className="inline-block mb-4 px-4 py-1 rounded-full bg-bg-main shadow-[inset_2px_2px_5px_rgba(0,0,0,0.2),inset_-2px_-2px_5px_rgba(255,255,255,0.1)] text-accent text-xs md:text-sm font-bold tracking-wider uppercase">
                  {t('landing:hero.badge', { version: __APP_VERSION__ })}
                </motion.div>
                <motion.h1 variants={itemVariants} className="text-5xl md:text-7xl font-black tracking-tighter leading-none mb-6">
                  {t('landing:hero.title_prefix')}<br />
                  <span className="text-accent" style={{ textShadow: '2px 2px 4px rgba(255, 107, 53, 0.3)' }}>{t('landing:hero.title_highlight')}</span><br />
                  {t('landing:hero.title_suffix')}
                </motion.h1>
                <motion.p variants={itemVariants} className="text-lg md:text-xl text-text-secondary max-w-xl mb-8 leading-relaxed">
                  {t('landing:hero.description')}
                </motion.p>
                <motion.div variants={itemVariants} className="flex flex-col sm:flex-row justify-start items-start gap-4">
                  {/* PERBAIKAN 2: Link menjadi tag <a> */}
                  <a href={`${APP_URL}/register`} className="px-8 py-4 rounded-lg bg-accent text-white font-bold shadow-[5px_5px_10px_rgba(0,0,0,0.3),-5px_-5px_10px_rgba(255,255,255,0.1)] hover:shadow-[inset_2px_2px_5px_rgba(0,0,0,0.3)] transition-all flex items-center">
                    {t('landing:hero.cta_start')} <FiArrowRight className="ml-2" />
                  </a>
                  <a href="https://github.com/h4nzs/nyx-chat" target="_blank" rel="noopener noreferrer" className="px-8 py-4 rounded-lg bg-bg-surface text-text-primary shadow-[3px_3px_6px_rgba(0,0,0,0.2),-3px_-3px_6px_rgba(255,255,255,0.1)] hover:shadow-[inset_1px_1px_3px_rgba(0,0,0,0.2)] transition-all flex items-center">
                    <FiGithub className="mr-2" />
                    {t('landing:hero.cta_source')}
                  </a>
                </motion.div>
              </motion.div>
            </div>

            {/* Visual Mockup */}
            <div className="lg:col-span-5 flex justify-center lg:justify-end">
               <motion.div 
                 initial={{ opacity: 0, x: 20 }}
                 animate={{ opacity: 1, x: 0 }}
                 transition={{ delay: 0.5, duration: 0.8 }}
                 className="relative w-full max-w-[280px] md:max-w-[320px]"
               >
                  <div className="relative mx-auto border-gray-800 dark:border-gray-900 bg-gray-900 border-[10px] rounded-[2.5rem] shadow-[20px_20px_40px_rgba(0,0,0,0.4),-10px_-10px_30px_rgba(255,255,255,0.05)] overflow-hidden">
                      <div className="h-[32px] w-[3px] bg-gray-800 absolute -start-[13px] top-[72px] rounded-s-lg"></div>
                      <div className="h-[46px] w-[3px] bg-gray-800 absolute -start-[13px] top-[124px] rounded-s-lg"></div>
                      <div className="h-[46px] w-[3px] bg-gray-800 absolute -start-[13px] top-[178px] rounded-s-lg"></div>
                      <div className="h-[64px] w-[3px] bg-gray-800 absolute -end-[13px] top-[142px] rounded-e-lg"></div>
                      
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
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black mb-6 tracking-tighter">{t('landing:why.title')}</motion.h2>
              <motion.p variants={itemVariants} className="text-lg md:text-xl text-text-secondary mb-4">
                {t('landing:why.desc_1')}
              </motion.p>
              <motion.p variants={itemVariants} className="text-lg md:text-xl text-text-secondary">
                {t('landing:why.desc_2')}
              </motion.p>
            </div>
          </AnimatedSection>
        </section>

        {/* COMPARISON TABLE */}
        <section className="py-16 md:py-24">
          <AnimatedSection>
            <div className="max-w-5xl mx-auto px-4">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black text-center mb-12 tracking-tighter">{t('landing:comparison.title')}</motion.h2>
              
              <div className="bg-bg-surface rounded-3xl p-6 md:p-8 shadow-[inset_3px_3px_6px_rgba(0,0,0,0.2),inset_-3px_-3px_6px_rgba(255,255,255,0.05)] overflow-x-auto">
                <table className="w-full min-w-[600px] border-separate border-spacing-y-4">
                  <thead>
                    <tr className="text-text-secondary text-sm uppercase tracking-wider">
                      <th className="text-left py-4 px-6">{t('landing:comparison.headers.feature')}</th>
                      <th className="py-4 px-4 font-normal">{t('landing:comparison.headers.wa')}</th>
                      <th className="py-4 px-4 font-normal">{t('landing:comparison.headers.tg')}</th>
                      <th className="py-4 px-6 text-accent font-black text-lg">{t('landing:comparison.headers.nyx')}</th>
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
                            {row.wa === t('landing:comparison.values.yes') || row.wa === t('landing:comparison.values.required') ? (
                                <>
                                    <span className="sr-only">{t('landing:a11y.not_supported', 'Not Supported/Bad')}</span>
                                    <div aria-hidden="true"><FiX/></div>
                                </>
                            ) : null} 
                            {row.wa}
                          </div>
                        </td>
                        <td className="py-4 px-4 text-center text-yellow-500 bg-bg-main/50">
                          {row.tg}
                        </td>
                        <td className="py-4 px-6 text-center text-green-500 font-bold bg-bg-main rounded-r-xl shadow-[inset_-2px_2px_5px_rgba(0,0,0,0.1)]">
                          <div className="flex items-center justify-center gap-2">
                            <span className="sr-only">{t('landing:a11y.supported', 'Supported/Good')}</span>
                            <div aria-hidden="true"><FiCheck className="text-xl" /></div> 
                            {row.nyx}
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

        {/* Features Section */}
        <section className="py-16 md:py-24" style={{ backgroundColor: theme === 'dark' ? '#222222' : '#e8e2d5' }}>
          <AnimatedSection>
            <div className="max-w-6xl mx-auto px-4">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black text-center mb-12 tracking-tighter">{t('landing:features.title')}</motion.h2>
              <motion.div variants={containerVariants} className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
                
                <FeatureCard icon={<FiHash size={24} />} title={t('landing:features.no_phone.title')}>
                  {t('landing:features.no_phone.desc')}
                </FeatureCard>

                <FeatureCard icon={<FiEyeOff size={24} />} title={t('landing:features.ghost_app.title')}>
                  {t('landing:features.ghost_app.desc')}
                </FeatureCard>

                <FeatureCard icon={<FiCpu size={24} />} title={t('landing:features.argon2.title')}>
                  {t('landing:features.argon2.desc')}
                </FeatureCard>

                <FeatureCard icon={<div className="flex gap-2"><FiSun size={24} /><FiMoon size={24} /></div>} title={t('landing:features.tactile.title')}>
                  {t('landing:features.tactile.desc')}
                </FeatureCard>

              </motion.div>
            </div>
          </AnimatedSection>
        </section>

        {/* How It Works Section */}
        <section className="py-16 md:py-24">
          <AnimatedSection>
            <div className="max-w-6xl mx-auto px-4">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black text-center mb-16 tracking-tighter">{t('landing:how_it_works.title')}</motion.h2>
              <motion.div variants={containerVariants} className="relative grid md:grid-cols-3 gap-12">
                <HowItWorksStep icon={<FiUserPlus size={24} />} title={t('landing:how_it_works.step_1.title')}>
                  {t('landing:how_it_works.step_1.desc')}
                </HowItWorksStep>
                <HowItWorksStep icon={<FiMessageSquare size={24} />} title={t('landing:how_it_works.step_2.title')}>
                  {t('landing:how_it_works.step_2.desc')}
                </HowItWorksStep>
                <HowItWorksStep icon={<FiShield size={24} />} title={t('landing:how_it_works.step_3.title')}>
                  {t('landing:how_it_works.step_3.desc')}
                </HowItWorksStep>
              </motion.div>
            </div>
          </AnimatedSection>
        </section>

        {/* Testimonials Section */}
        <section className="py-16 md:py-24" style={{ backgroundColor: theme === 'dark' ? '#222222' : '#e8e2d5' }}>
          <AnimatedSection>
            <div className="max-w-4xl mx-auto px-4">
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black text-center mb-12 tracking-tighter">{t('landing:testimonials.title')}</motion.h2>
              <motion.div variants={containerVariants} className="grid md:grid-cols-2 gap-8">
                <TestimonialCard author="Yosep." role={t('landing:testimonials.yosep_role')}>
                  {t('landing:testimonials.yosep')}
                </TestimonialCard>
                <TestimonialCard author="Sarah T." role={t('landing:testimonials.sarah_role')}>
                  {t('landing:testimonials.sarah')}
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
              <motion.h2 variants={itemVariants} className="text-3xl md:text-4xl font-black mb-6 tracking-tighter">{t('landing:cta.title')}</motion.h2>
              <motion.p variants={itemVariants} className="text-lg text-text-secondary mb-8 max-w-2xl mx-auto">
                {t('landing:cta.desc')}
              </motion.p>
              <motion.div variants={itemVariants}>
                {/* PERBAIKAN 3: Link menjadi tag <a> */}
                <a href={`${APP_URL}/register`} className="px-8 py-4 rounded-lg bg-accent text-white font-bold shadow-[5px_5px_10px_rgba(0,0,0,0.3),-5px_-5px_10px_rgba(255,255,255,0.1)] hover:shadow-[inset_2px_2px_5px_rgba(0,0,0,0.3)] transition-all inline-flex items-center">
                  {t('landing:cta.button')} <FiArrowRight className="ml-2" />
                </a>
              </motion.div>
            </div>
          </AnimatedSection>
        </section>

        {/* Footer */}
        <footer className="py-12 border-t border-white/5 bg-bg-main relative overflow-hidden">
          {/* Tactical Background Glow */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-md h-[1px] bg-gradient-to-r from-transparent via-accent/50 to-transparent"></div>

          <div className="max-w-6xl mx-auto px-6 text-center text-text-secondary flex flex-col items-center">
            {/* Insignia & Brand */}
            <div className="flex items-center justify-center gap-3 mb-4">
              <img
                src="/pwa-512x512.png"
                alt="NYX"
                className="w-6 h-6 grayscale hover:grayscale-0 transition-all duration-300"
              />
              <span className="text-sm font-black tracking-[0.3em] text-text-primary uppercase">NYX</span>
            </div>

            {/* Copyright & Core License */}
            <p className="text-sm font-medium mb-3">
              {t('landing:footer.rights', { year: new Date().getFullYear() })} <span className="font-bold text-white">AGPL-3.0</span>.
            </p>

            {/* Intelligence Links */}
            <div className="flex flex-wrap justify-center items-center gap-3 text-xs font-bold mt-1 mb-8">
              <a href="/privacy" className="hover:text-accent transition-colors tracking-wide">{t('landing:footer.legal')}</a>
              <span className="text-white/10">•</span>
              <a href="https://github.com/h4nzs/nyx-chat" target="_blank" rel="noopener noreferrer" className="hover:text-accent transition-colors tracking-wide">{t('landing:footer.source')}</a>
              <span className="text-white/10">•</span>
              <a href="https://github.com/h4nzs/nyx-chat/blob/main/COMMERCIAL.md" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-white transition-colors tracking-wide">{t('landing:footer.commercial')}</a>
            </div>

            {/* Disclaimer Hukum (The Shield) */}
            <p className="text-[10px] text-text-secondary/40 max-w-3xl mx-auto leading-relaxed font-mono">
              {t('landing:footer.disclaimer', { year: new Date().getFullYear() })}
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}

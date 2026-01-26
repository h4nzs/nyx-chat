import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    screens: {
      'md': '768px',
      'lg': '1024px',
      'xl': '1280px',
      '2xl': '1920px',
    },
    extend: {
      neumorph: {
          light: '#e0e5ec', // Putih keabuan (Classic)
          dark: '#1a1b1e',  // Dark slate
        },
      boxShadow: {
        'neumorphic-convex': '5px 5px 10px hsl(var(--shadow-dark)), -5px -5px 10px hsl(var(--shadow-light))',
        'neumorphic-convex-sm': '2px 2px 5px hsl(var(--shadow-dark)), -2px -2px 5px hsl(var(--shadow-light))',
        'neumorphic-concave': 'inset 5px 5px 10px hsl(var(--shadow-dark)), inset -5px -5px 10px hsl(var(--shadow-light))',
        'neumorphic-concave-sm': 'inset 2px 2px 5px hsl(var(--shadow-dark)), inset -2px -2px 5px hsl(var(--shadow-light))',
        'neumorphic-pressed': 'inset 2px 2px 5px hsl(var(--shadow-dark)), inset -2px -2px 5px hsl(var(--shadow-light))',
        'neumorphic-pressed-sm': 'inset 1px 1px 3px hsl(var(--shadow-dark)), inset -1px -1px 3px hsl(var(--shadow-light))',
        'soft': '0 1px 3px 0 hsl(var(--shadow-color) / 0.1), 0 1px 2px 0 hsl(var(--shadow-color) / 0.06)',
        'card': '0 4px 12px hsl(var(--shadow-color) / 0.15)',
        'neu-flat-light': '9px 9px 16px rgb(163,177,198,0.6), -9px -9px 16px rgba(255,255,255, 0.5)',
        'neu-pressed-light': 'inset 6px 6px 10px 0 rgba(163,177,198, 0.7), inset -6px -6px 10px 0 rgba(255,255,255, 0.8)',
        'neu-convex-light': '5px 5px 10px rgb(163,177,198,0.6), -5px -5px 10px rgba(255,255,255, 0.5)',
        
        // --- NEUMORPHISM DARK ---
        'neu-flat-dark': '5px 5px 10px #0b0c0e, -5px -5px 10px #292a2e',
        'neu-pressed-dark': 'inset 5px 5px 10px #0b0c0e, inset -5px -5px 10px #292a2e',
        'neu-convex-dark': '3px 3px 6px #0b0c0e, -3px -3px 6px #292a2e',
      },
      backgroundImage: {
        'aurora-gradient': 'linear-gradient(to right, hsl(var(--grad-start)), hsl(var(--grad-end)))',
      },
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--bg-main) / <alpha-value>)', // App background
        foreground: 'hsl(var(--text-primary) / <alpha-value>)', // Main text

        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },

        // Custom Semantic Colors
        'bg-main': 'hsl(var(--bg-main) / <alpha-value>)',
        'bg-surface': 'hsl(var(--bg-surface) / <alpha-value>)',
        'text-primary': 'hsl(var(--text-primary) / <alpha-value>)',
        'text-secondary': 'hsl(var(--text-secondary) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'fade-in-up': 'fadeInUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;

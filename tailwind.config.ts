import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    '*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          '1': 'hsl(var(--chart-1))',
          '2': 'hsl(var(--chart-2))',
          '3': 'hsl(var(--chart-3))',
          '4': 'hsl(var(--chart-4))',
          '5': 'hsl(var(--chart-5))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
        // Aave 颜色配置
        aave: {
          // 主色调
          primary: '#B6509E',
          secondary: '#2EBAC6',
          accent: '#5B8DEF',
          // 背景色
          bg: {
            primary: '#0E0E2E',
            secondary: '#1B1B3A',
            tertiary: '#252547',
          },
          // 卡片和表面
          surface: {
            DEFAULT: 'rgba(27, 27, 58, 0.6)',
            hover: 'rgba(37, 37, 71, 0.8)',
            border: 'rgba(255, 255, 255, 0.08)',
          },
          // 文字颜色
          text: {
            primary: '#FFFFFF',
            secondary: '#A5A8B6',
            muted: '#62677B',
          },
          // 状态颜色
          success: '#3AB795',
          warning: '#F89D49',
          error: '#F06565',
          // 渐变色
          purple: '#B6509E',
          cyan: '#2EBAC6',
          blue: '#5B8DEF',
        },
      },
      backgroundImage: {
        'aave-gradient': 'linear-gradient(135deg, #0E0E2E 0%, #1B1B3A 50%, #252547 100%)',
        'aave-card': 'linear-gradient(135deg, rgba(27, 27, 58, 0.6) 0%, rgba(37, 37, 71, 0.4) 100%)',
        'aave-accent': 'linear-gradient(90deg, #B6509E 0%, #2EBAC6 100%)',
        'aave-accent-hover': 'linear-gradient(90deg, #C760AE 0%, #3ECAD6 100%)',
        'aave-glow': 'radial-gradient(ellipse at center, rgba(182, 80, 158, 0.15) 0%, transparent 70%)',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        'aave': '0 4px 24px rgba(0, 0, 0, 0.3)',
        'aave-glow': '0 0 40px rgba(182, 80, 158, 0.2)',
        'aave-card': '0 8px 32px rgba(0, 0, 0, 0.4)',
      },
      animation: {
        'gradient': 'gradient 3s ease infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shimmer': 'shimmer 2s linear infinite',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
      keyframes: {
        gradient: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'accordion-down': {
          from: {
            height: '0',
          },
          to: {
            height: 'var(--radix-accordion-content-height)',
          },
        },
        'accordion-up': {
          from: {
            height: 'var(--radix-accordion-content-height)',
          },
          to: {
            height: '0',
          },
        },
      },
      backdropBlur: {
        'aave': '20px',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
export default config

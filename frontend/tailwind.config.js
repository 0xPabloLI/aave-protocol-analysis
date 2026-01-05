/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        aave: {
          primary: '#1B3A6F',
          secondary: '#2D4F8F',
          accent: '#5B8DEF',
          purple: '#B6509E',
          dark: '#0A0E27',
          'dark-card': '#1A1F3A',
          'dark-border': '#2A2F4A',
          'blue-light': '#5B8DEF',
          'blue-dark': '#1B3A6F',
        },
      },
      backgroundImage: {
        'aave-gradient': 'linear-gradient(135deg, #0A0E27 0%, #1A1F3A 50%, #2D4F8F 100%)',
        'aave-card': 'linear-gradient(135deg, #1A1F3A 0%, #2A2F4A 100%)',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
}


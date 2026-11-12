/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        medicare: {
          primary: '#2563EB',
          'primary-hover': '#1D4ED8',
          'primary-light': '#EFF6FF',
          navy: '#142D4E',
          'navy-dark': '#0B1B30',
          'navy-light': '#1E3A5F',
          bg: '#F8FAFC',
          success: '#16A34A',
          'success-light': '#F0FDF4',
          warning: '#D97706',
          'warning-light': '#FFFBEB',
          danger: '#DC2626',
          'danger-light': '#FEF2F2',
        },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
        heading: ['"Plus Jakarta Sans"', 'sans-serif'],
      },
      borderRadius: {
        'medicare': '16px',
        'medicare-lg': '20px',
      },
      boxShadow: {
        'medicare-card': '0 1px 3px 0 rgba(20, 45, 78, 0.05), 0 1px 2px -1px rgba(20, 45, 78, 0.05)',
        'medicare-hover': '0 8px 20px -4px rgba(20, 45, 78, 0.08), 0 4px 8px -2px rgba(20, 45, 78, 0.04)',
      },
    },
  },
  plugins: [],
};


import { motion } from 'framer-motion';

/**
 * AnimatedCard
 * MediCare+ design system reusable card component with gentle entrance animation (16px upward shift)
 * and optional subtle 200ms hover elevation.
 */
export default function AnimatedCard({
  children,
  className = '',
  delay = 0,
  hoverEffect = false,
  onClick,
  ...props
}) {
  const hoverProps = hoverEffect
    ? {
        whileHover: {
          y: -3,
          transition: { duration: 0.2, ease: 'easeOut' },
        },
      }
    : {};

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{
        duration: 0.35,
        ease: [0.16, 1, 0.3, 1],
        delay,
      }}
      onClick={onClick}
      className={`rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs transition-shadow duration-200 ${
        hoverEffect ? 'hover:shadow-md cursor-pointer' : ''
      } ${className}`}
      {...hoverProps}
      {...props}
    >
      {children}
    </motion.div>
  );
}


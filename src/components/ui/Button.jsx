import { useRef } from "react";
import { ArrowRight } from "lucide-react";
import { motion } from "framer-motion";
import { useMagnetic } from "../../animations/magnetic";

/**
 * Premium CTA button. `variant="solid"` for the primary racing-green fill,
 * `variant="gold"` for the antique-gold filled CTA reserved for the final
 * cinematic section, `variant="outline"` for a gold-hairline secondary
 * action on dark grounds, `variant="link"` for a text-only underline CTA
 * (callers supply text color via className for link/outline-on-light use).
 */
export default function Button({
  children,
  variant = "solid",
  href,
  onClick,
  className = "",
  showArrow = true,
  type = "button",
}) {
  const magRef = useRef(null);
  useMagnetic(magRef, variant === "link" ? 0 : 0.25);

  const base =
    "group relative inline-flex items-center gap-2.5 font-sans text-xs tracking-[0.22em] uppercase transition-colors duration-500";

  const variants = {
    solid:
      "px-8 py-4 bg-racing-green text-warm-ivory hover:bg-deep-forest border border-racing-green hover:border-antique-gold",
    gold:
      "px-8 py-4 bg-antique-gold text-deep-forest border border-antique-gold hover:bg-champagne-gold hover:border-champagne-gold",
    outline:
      "px-8 py-4 border border-antique-gold/70 text-warm-ivory hover:border-antique-gold hover:bg-antique-gold/10",
    link: "pb-1",
  };

  const Comp = href ? "a" : "button";

  const content = (
    <>
      <span className="relative">
        {children}
        {variant === "link" && (
          <span className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-100 bg-current" />
        )}
      </span>
      {showArrow && (
        <motion.span
          className="inline-flex"
          initial={{ x: 0 }}
          whileHover={{ x: 4 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        >
          <ArrowRight size={14} strokeWidth={1.75} />
        </motion.span>
      )}
    </>
  );

  return (
    <Comp
      ref={magRef}
      href={href}
      onClick={onClick}
      type={href ? undefined : type}
      data-cursor={variant === "link" ? "link" : "explore"}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {content}
    </Comp>
  );
}

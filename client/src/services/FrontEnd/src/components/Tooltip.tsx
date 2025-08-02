interface TooltipProps {
  content: React.ReactNode;
  show?: boolean;
  className?: string;
}

const Tooltip: React.FC<React.PropsWithChildren<TooltipProps>> = ({ content, show, className = "", children }) => (
  <div className={`tooltip-container ${className}`} tabIndex={0}>
    {children}
    <div className={`tooltip ${show ? "visible opacity-100" : ""}`}>{content}</div>
  </div>
);

export default Tooltip;

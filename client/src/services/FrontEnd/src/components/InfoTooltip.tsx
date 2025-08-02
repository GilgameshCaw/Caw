import { IoMdInformationCircleOutline } from "react-icons/io";

interface InfoTooltipProps {
  content: React.ReactNode;
  show?: boolean;
  size?: number;
  className?: string;
}

const InfoTooltip: React.FC<InfoTooltipProps> = ({ content, show, size = 24, className = "" }) => (
  <button className="tooltip-container relative -mt-1 -mb-1 -ml-1 flex cursor-pointer items-center p-1" role="button">
    <IoMdInformationCircleOutline
      className="tooltip-icon text-accent block"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        minWidth: `${size}px`,
        minHeight: `${size}px`,
      }}
    />
    <div className={`tooltip ${className} ${show ? "visible opacity-100" : ""}`}>{content}</div>
  </button>
);

export default InfoTooltip;

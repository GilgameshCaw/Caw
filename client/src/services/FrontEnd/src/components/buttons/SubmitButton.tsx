import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import Spinner from "~/assets/images/spinner.svg?react";

interface SubmitButtonProps {
  className?: string;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

export const SubmitButton: React.FC<React.PropsWithChildren<SubmitButtonProps>> = ({
  children,
  className = "",
  disabled,
  loading,
  onClick,
}) => {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();

  if (!isConnected) {
    return (
      <button className={className} onClick={openConnectModal}>
        Connect Wallet
      </button>
    );
  }

  return (
    <button
      className={`${className} ${loading ? "btn-loading pointer-events-none" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {loading && (
        <div className="spinner-container">
          <Spinner className="spinner h-10 w-10" />
        </div>
      )}
      {children}
    </button>
  );
};

import { useEnsureWallet } from "~/hooks/useEnsureWallet";
import { useAccount } from "wagmi";
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
  const ensureWallet = useEnsureWallet();

  const handleClick = () => {
    if (!isConnected) {
      ensureWallet(null, async () => { onClick() })
    } else {
      onClick()
    }
  }

  return (
    <button
      className={`${className} ${loading ? "btn-loading pointer-events-none" : ""} ${disabled ? "pointer-events-none" : ""}`}
      onClick={handleClick}
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

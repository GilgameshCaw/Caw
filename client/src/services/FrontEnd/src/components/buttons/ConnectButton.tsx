import { ConnectButton as RainbowConnectButton } from "@rainbow-me/rainbowkit";

const ConnectButton = () => {
  return (
    <RainbowConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, authenticationStatus, mounted }) => {
        const ready = mounted && authenticationStatus !== "loading";
        const connected =
          ready && account && chain && (!authenticationStatus || authenticationStatus === "authenticated");

        return (
          <div
            {...(!ready && {
              "aria-hidden": true,
              style: {
                opacity: 0,
                pointerEvents: "none",
                userSelect: "none",
              },
            })}
          >
            {(() => {
              if (!connected) {
                return (
                  <button onClick={openConnectModal} type="button" className="btn btn-connect">
                    Connect Wallet
                  </button>
                );
              }

              if (chain.unsupported) {
                return (
                  <button onClick={openChainModal} type="button" className="btn btn-connect">
                    Wrong network
                  </button>
                );
              }

              return null;
            })()}
          </div>
        );
      }}
    </RainbowConnectButton.Custom>
  );
};

export default ConnectButton;

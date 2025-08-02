import { Toaster } from "react-hot-toast";
import { Modals } from "~/components/modals/Modals";
import Sidebar from "~/components/Sidebar";
import Trending from "~/components/Trending";

interface MainLayoutProps {
  children: React.ReactNode;
}

const MainLayout = ({ children }: MainLayoutProps) => {
  return (
    <div className="max-h-screen min-h-screen w-full max-w-[900px] flex m-auto">
      <div className="hidden sm:block border-r border-gray-700 h-full w-[300px]">
        <Sidebar/>
      </div>
      <main className="w-full p-3">{children}</main>
      <Toaster
        position="top-center"
        reverseOrder
        containerStyle={{ marginTop: "40px" }}
        toastOptions={{ removeDelay: 0 }}
      />
      <div className="hidden md:block w-[200px]">
        <div className="fixed border-l border-gray-700 h-full">
          <Trending/>
        </div>
      </div>
      <Modals />
    </div>
  );
};

export default MainLayout;

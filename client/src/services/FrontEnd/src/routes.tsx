import { Profile } from "./pages/Profile/Profile";
import { NewProfile } from "./pages/Profile/New";
import { PendingPage } from "./pages/Pending";
import { CawPage } from "./pages/CawPage";
import { Staking } from "./pages/Staking";
import { Main } from "./pages/Main";
import NotificationsPage from "./pages/NotificationsPage";
import { SettingsPage } from "./pages/Settings";
import MessagesPage from "./pages/Messages";
import ChatPage from "./pages/ChatPage";
import BookmarksPage from "./pages/Bookmarks";
import ExplorePage from "./pages/Explore";
import GameFiPage from "./pages/GameFiPage";
import VoiceRoom from "./pages/VoiceRoom";
import VoiceRoomActive from "./pages/VoiceRoomActive";
import { Navigate } from "react-router-dom";

// Wrapper components to handle required props
const VoiceRoomWrapper = () => {
  const handleStartRoom = (topic: string, isRecording: boolean) => {
    // Navigate to active room with the provided props
    window.location.href = `/voice-room-active?topic=${encodeURIComponent(topic)}&recording=${isRecording}`;
  };
  
  return <VoiceRoom onStartRoom={handleStartRoom} />;
};

const VoiceRoomActiveWrapper = () => {
  const urlParams = new URLSearchParams(window.location.search);
  const topic = urlParams.get('topic') || 'General Discussion';
  const isRecording = urlParams.get('recording') === 'true';
  
  const handleClose = () => {
    // Navigate back to voice room
    window.location.href = '/voice-room';
  };
  
  return (
    <VoiceRoomActive 
      onClose={handleClose}
      topic={topic}
      isRecording={isRecording}
    />
  );
};



export default [
  {
    path: "/",
    component: <Navigate to="/home" replace />,
  },
  {
    path: "/home",
    component: <Main />,
  },
  {
    path: "/explore",
    component: <ExplorePage />,
  },
  {
    path: "/pending",
    component: <PendingPage />,
  },
  {
    path: "/staking",
    component: <Staking />,
  },
  {
    path: "/mint",
    component: <NewProfile />,
  },
  {
    path: "/profile",
    component: <Profile />,
  },
  {
    path: "/users/:username",
    component: <Profile />,
  },
  {
    path: "/caws/:id",
    component: <CawPage />,
  },
  {
    path: "/notifications",
    component: <NotificationsPage />,
  },
  {
    path: "/messages",
    component: <MessagesPage />,
  },
  {
    path: "/chat",
    component: <ChatPage />,
  },
  {
    path: "/settings",
    component: <SettingsPage />,
  },
  {
    path: "/bookmarks",
    component: <BookmarksPage />,
  },
  {
    path: "/gamefi",
    component: <GameFiPage />,
  },
  {
    path: "/voice-room",
    component: <VoiceRoomWrapper />,
  },
  {
    path: "/voice-room-active",
    component: <VoiceRoomActiveWrapper />,
  },
];

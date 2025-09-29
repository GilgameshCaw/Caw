import React, { useState } from "react"
import MainLayout from "~/layouts/MainLayout"
import Notifications from "~/components/Notifications"
import MobileBottomNavbar from '~/components/MobileBottomNavbar'

const NotificationsPage: React.FC = () => {
  const [activeBottomTab, setActiveBottomTab] = useState('notifications')
  
  return (
    <MainLayout>
      <Notifications />

      {/* Mobile Bottom Navbar */}
      <MobileBottomNavbar 
        activeTab={activeBottomTab}
        onTabChange={(tab) => setActiveBottomTab(tab)}
        isVisible={true}
      />
    </MainLayout>
  )
}

export default NotificationsPage

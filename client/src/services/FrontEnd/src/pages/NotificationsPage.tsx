import React from "react"
import MainLayout from "~/layouts/MainLayout"
import Notifications from "~/components/Notifications"

const NotificationsPage: React.FC = () => {
  return (
    <MainLayout>
      <Notifications />
    </MainLayout>
  )
}

export default NotificationsPage

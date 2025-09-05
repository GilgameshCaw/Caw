import React, { useState } from "react"

type NotificationTab = "all" | "mentions"

const Notifications: React.FC = () => {
  const [activeTab, setActiveTab] = useState<NotificationTab>("all")
  
  return (
    <div className="w-full max-w-2xl mx-auto bg-black min-h-screen">
      {/* Header */}
      <div className="px-4 py-3">
        <h1 className="text-xl font-bold text-white">
          Notifications
        </h1>
      </div>
      
      {/* Tabs */}
      <div className="flex">
        <button
          onClick={() => setActiveTab("all")}
          className={`flex-1 px-8 py-4 text-lg font-medium transition-all duration-200 border-b-2 cursor-pointer ${
            activeTab === "all"
              ? 'text-white border-white'
              : 'text-gray-400 border-transparent hover:text-white'
          }`}
        >
          All
        </button>
        <button
          onClick={() => setActiveTab("mentions")}
          className={`flex-1 px-8 py-4 text-lg font-medium transition-all duration-200 border-b-2 cursor-pointer ${
            activeTab === "mentions"
              ? 'text-white border-white'
              : 'text-gray-400 border-transparent hover:text-white'
          }`}
        >
          Mentions
        </button>
      </div>

      {/* Notifications List */}
      <div className="divide-y divide-white/20">
        <div className="px-4 py-8 text-center">
          <p className="text-lg font-medium text-white">
            No notifications yet
          </p>
          <p className="text-sm mt-1 text-gray-400">
            {activeTab === "mentions" 
              ? "When someone mentions you, it'll show up here"
              : "When you get notifications, they'll show up here"
            }
          </p>
        </div>
      </div>
    </div>
  )
}

export default Notifications
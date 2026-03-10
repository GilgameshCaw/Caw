import React, { useState } from 'react'
import { HiOutlineUserGroup, HiOutlineX, HiOutlinePlus, HiOutlineSearch } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'

interface User {
  id: number
  username: string
  image?: string
  walletAddress?: string
}

interface GroupChatModalProps {
  currentUserId?: number
  onCreateGroup: (participants: number[], name: string, description?: string) => void
  onClose: () => void
}

const GroupChatModal: React.FC<GroupChatModalProps> = ({
  currentUserId,
  onCreateGroup,
  onClose
}) => {
  const { isDark } = useTheme()
  const [groupName, setGroupName] = useState('')
  const [groupDescription, setGroupDescription] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedUsers, setSelectedUsers] = useState<User[]>([])
  const [isCreating, setIsCreating] = useState(false)

  // Mock users for demonstration - replace with actual user search
  const mockUsers: User[] = [
    { id: 1, username: 'alice.eth', image: '/avatars/alice.jpg' },
    { id: 2, username: 'bob_builder', image: '/avatars/bob.jpg' },
    { id: 3, username: 'charlie123' },
    { id: 4, username: 'david.sol' },
    { id: 5, username: 'emma_dao', image: '/avatars/emma.jpg' },
  ].filter(u => u.id !== currentUserId)

  const filteredUsers = mockUsers.filter(user =>
    user.username.toLowerCase().includes(searchQuery.toLowerCase()) &&
    !selectedUsers.some(selected => selected.id === user.id)
  )

  const handleAddUser = (user: User) => {
    setSelectedUsers([...selectedUsers, user])
    setSearchQuery('')
  }

  const handleRemoveUser = (userId: number) => {
    setSelectedUsers(selectedUsers.filter(u => u.id !== userId))
  }

  const handleCreateGroup = async () => {
    if (!groupName.trim() || selectedUsers.length === 0) return

    setIsCreating(true)
    try {
      const participantIds = selectedUsers.map(u => u.id)
      await onCreateGroup(participantIds, groupName, groupDescription)
      onClose()
    } catch (error) {
      console.error('Error creating group:', error)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-md rounded-2xl transition-all duration-300 ${
          isDark ? 'bg-black border border-yellow-500/30' : 'bg-white border border-gray-200'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`p-4 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <HiOutlineUserGroup className={`w-6 h-6 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`} />
              <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                Create Group Chat
              </h2>
            </div>
            <button
              onClick={onClose}
              className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 ${
                isDark ? 'text-white' : 'text-black'
              }`}
            >
              <HiOutlineX className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Group Name */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${
              isDark ? 'text-gray-300' : 'text-gray-700'
            }`}>
              Group Name *
            </label>
            <input
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Enter group name"
              className={`w-full px-4 py-2 rounded-lg border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-yellow-500/30 ${
                isDark
                  ? 'bg-black border-gray-600 text-white placeholder-gray-400'
                  : 'bg-white border-gray-300 text-black placeholder-gray-500'
              }`}
            />
          </div>

          {/* Group Description */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${
              isDark ? 'text-gray-300' : 'text-gray-700'
            }`}>
              Description (Optional)
            </label>
            <textarea
              value={groupDescription}
              onChange={(e) => setGroupDescription(e.target.value)}
              placeholder="What's this group about?"
              rows={2}
              className={`w-full px-4 py-2 rounded-lg border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-yellow-500/30 resize-none ${
                isDark
                  ? 'bg-black border-gray-600 text-white placeholder-gray-400'
                  : 'bg-white border-gray-300 text-black placeholder-gray-500'
              }`}
            />
          </div>

          {/* Selected Users */}
          {selectedUsers.length > 0 && (
            <div>
              <label className={`block text-sm font-medium mb-2 ${
                isDark ? 'text-gray-300' : 'text-gray-700'
              }`}>
                Selected Members ({selectedUsers.length})
              </label>
              <div className="flex flex-wrap gap-2">
                {selectedUsers.map((user) => (
                  <div
                    key={user.id}
                    className={`flex items-center space-x-2 px-3 py-1 rounded-full ${
                      isDark ? 'bg-gray-800' : 'bg-gray-100'
                    }`}
                  >
                    <span className={`text-sm ${isDark ? 'text-white' : 'text-black'}`}>
                      {user.username}
                    </span>
                    <button
                      onClick={() => handleRemoveUser(user.id)}
                      className={`hover:opacity-70 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
                    >
                      <HiOutlineX className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* User Search */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${
              isDark ? 'text-gray-300' : 'text-gray-700'
            }`}>
              Add Members *
            </label>
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search users to add..."
                className={`w-full pl-10 pr-4 py-2 rounded-lg border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-yellow-500/30 ${
                  isDark
                    ? 'bg-black border-gray-600 text-white placeholder-gray-400'
                    : 'bg-white border-gray-300 text-black placeholder-gray-500'
                }`}
              />
              <HiOutlineSearch className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 ${
                isDark ? 'text-gray-400' : 'text-gray-500'
              }`} />
            </div>

            {/* Search Results */}
            {searchQuery && filteredUsers.length > 0 && (
              <div className={`mt-2 max-h-40 overflow-y-auto rounded-lg border ${
                isDark ? 'bg-gray-900 border-gray-700' : 'bg-gray-50 border-gray-200'
              }`}>
                {filteredUsers.map((user) => (
                  <button
                    key={user.id}
                    onClick={() => handleAddUser(user)}
                    className={`w-full flex items-center justify-between p-3 hover:bg-gray-500/10 transition-all duration-200 ${
                      isDark ? 'text-white' : 'text-black'
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      {user.image ? (
                        <img
                          src={user.image}
                          alt={user.username}
                          className="w-8 h-8 rounded-full object-cover"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center">
                          <span className="text-white font-semibold text-sm">
                            {user.username[0].toUpperCase()}
                          </span>
                        </div>
                      )}
                      <span className="text-sm font-medium">{user.username}</span>
                    </div>
                    <HiOutlinePlus className="w-4 h-4" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className={`p-4 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <div className="flex space-x-3">
            <button
              onClick={onClose}
              className={`flex-1 px-4 py-2 rounded-lg font-medium transition-all duration-300 ${
                isDark
                  ? 'bg-gray-800 hover:bg-gray-700 text-white'
                  : 'bg-gray-200 hover:bg-gray-300 text-black'
              }`}
            >
              Cancel
            </button>
            <button
              onClick={handleCreateGroup}
              disabled={!groupName.trim() || selectedUsers.length === 0 || isCreating}
              className="flex-1 px-4 py-2 rounded-lg font-medium bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCreating ? 'Creating...' : 'Create Group'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default GroupChatModal
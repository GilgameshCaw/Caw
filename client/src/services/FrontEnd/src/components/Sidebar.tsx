// src/services/FrontEnd/src/components/Sidebar.tsx
import React, { useEffect, useState } from 'react'
import { NavLink }              from 'react-router-dom'
import ProfileChooser           from '~/components/ProfileChooser'
import { fetchTxPage }          from '../api/txs'
import { useTokenDataStore } from "~/store/tokenDataStore";

const links = ['Home','Explore','Notifications','Messages','Profile'] as const

const Sidebar: React.FC = () => {
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const [pending, setPending] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!activeTokenId) return setPending(0)
      try {
        // hit our paginated endpoint with page=1,limit=1 to just get total
        const { total } = await fetchTxPage(activeTokenId, 1, 1)
        if (!cancelled) setPending(total)
      } catch (err) {
        console.error('Could not load pending count', err)
      }
    }
    load()
    const iv = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [activeTokenId])

  return (
    <div className="flex flex-col h-full justify-between w-[200px] border-r border-gray-700 fixed">
      <nav className="p-4 space-y-4">
        <NavLink
        to="/home"
        className={({ isActive }) =>
          `relative block px-2 py-1 rounded hover:bg-gray-700 ${isActive ? 'bg-gray-800' : ''}`
        }>

        Home
      </NavLink>

        {/* Pending link with badge */}
        <NavLink
        to="/pending"
        className={({ isActive }) =>
          `relative block px-2 py-1 rounded hover:bg-gray-700 ${isActive ? 'bg-gray-800' : ''}`
        }
            >
      Pending
    {pending > 0 && (
      <span className="absolute top-0 right-0 inline-flex items-center justify-center
      px-2 py-0.5 text-xs font-medium text-white bg-red-600 rounded-full
      transform translate-x-1/2 -translate-y-1/2">
      {pending}
      </span>
    )}
      </NavLink>

      <NavLink
        to="/staking"
        className={({ isActive }) =>
          `relative block px-2 py-1 rounded hover:bg-gray-700 ${isActive ? 'bg-gray-800' : ''}`
        }
            >
        Staking
      </NavLink>
      <NavLink
        to="/mint"
        className={({ isActive }) =>
          `relative block px-2 py-1 rounded hover:bg-gray-700 ${isActive ? 'bg-gray-800' : ''}`
        }
            >
        Mint
      </NavLink>
    </nav>

    <div className="p-4 absolute bottom-0">
      <ProfileChooser/>
    </div>
  </div>
  )
}

export default Sidebar


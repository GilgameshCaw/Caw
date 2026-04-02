import React, { useState, useEffect } from 'react'
import { useTheme } from '~/hooks/useTheme'

function calc(endTime: string) {
  const ms = new Date(endTime).getTime() - Date.now()
  if (ms <= 0) return null
  const d = Math.floor(ms / 86400000)
  const h = Math.floor((ms % 86400000) / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return { d, h, m, s }
}

const LiveCountdown: React.FC<{ endTime: string }> = ({ endTime }) => {
  const { isDark } = useTheme()
  const [time, setTime] = useState(() => calc(endTime))

  useEffect(() => {
    const id = setInterval(() => setTime(calc(endTime)), 1000)
    return () => clearInterval(id)
  }, [endTime])

  if (!time) {
    return <span className={`text-xs ${isDark ? 'text-red-400' : 'text-red-500'}`}>Ended</span>
  }

  const muted = isDark ? 'text-gray-500' : 'text-gray-400'
  const text = isDark ? 'text-gray-400' : 'text-gray-500'

  let main = ''
  if (time.d > 0) main = `${time.d}d ${time.h}h ${time.m}m`
  else if (time.h > 0) main = `${time.h}h ${time.m}m`
  else main = `${time.m}m`

  return (
    <span className={`text-xs ${text}`}>
      {main}
      <span className={`ml-0.5 text-[10px] ${muted}`}>
        {String(time.s).padStart(2, '0')}s
      </span>
    </span>
  )
}

export default LiveCountdown

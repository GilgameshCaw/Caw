import React from 'react'

const trends = [
  '#CawProtocol',
  '#Gilgamesh',
  '#TehFutureIsHere',
  '#IAmRyoshi',
  '#DecentralizedFreedom',
  '#Cawmmunity',
  '#OneWhoStillDreams'
]

const Trending: React.FC = () => (
  <div className="p-4 space-y-3">
    <h2 className="font-bold">Trending</h2>
    {trends.map(t => (
      <div key={t} className="cursor-pointer p-2 hover:bg-gray-800 rounded">
        {t}
      </div>
    ))}
  </div>
)

export default Trending


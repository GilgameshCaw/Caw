import { useInstanceStore } from '../../../client/src/services/FrontEnd/src/store/instanceStore'
window.discover = async (networkId = 1) => {
  const before = { keys: Object.keys(localStorage), peers: useInstanceStore.getState().instances.length }
  await useInstanceStore.getState().fetchInstances(networkId)
  const state = useInstanceStore.getState()
  return { before, source: state.loadedFrom, error: state.error, peers: state.instances,
    hosts: state.getApiHosts(), cached: JSON.parse(localStorage.getItem('caw:instances:' + networkId)) }
}

window.peerSnapshot = () => {
  const state = useInstanceStore.getState()
  return { peers: state.instances, hosts: state.getApiHosts(), pinned: state.activeApiHost,
    loading: state.isLoading, source: state.loadedFrom, error: state.error }
}
window.pinPeer = host => useInstanceStore.getState().setActiveApiHost(host)

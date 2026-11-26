import { useInstanceStore } from '../../../client/src/services/FrontEnd/src/store/instanceStore'
window.discover = async () => {
  const before = { keys: Object.keys(localStorage), peers: useInstanceStore.getState().instances.length }
  await useInstanceStore.getState().fetchInstances(1)
  const state = useInstanceStore.getState()
  return { before, source: state.loadedFrom, error: state.error, peers: state.instances,
    hosts: state.getApiHosts(), cached: JSON.parse(localStorage.getItem('caw:instances:1')) }
}

import { apiFetch } from './client'

export type TxQueueItem = {
	id:        number
	senderId:  number
	payload:   any
	signedTx:  string
	status:    string
	createdAt: string
	updatedAt: string
}

export type TxPage = {
	page:   number
	limit:  number
	total:  number
	pages:  number
	items:  TxQueueItem[]
}

/** natstat: fetch one page of pending txs for a senderId */
export function fetchTxPage(
	senderId: number,
	page = 1,
	limit = 20
): Promise<TxPage> {
	const params = new URLSearchParams({
		senderId: String(senderId),
		page:     String(page),
		limit:    String(limit)
	})
	console.log("SENDING REQUEST!")
	return apiFetch(`/api/txs?${params.toString()}`)
}


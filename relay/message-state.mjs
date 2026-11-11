// Shared by the message API and the owner's activity list. Acknowledgement is not execution.
export function messageState(m, { replied = false, quiet = false, notAnsweringAfterRings } = {}) {
  return replied ? 'replied'
    : m.status === 'delivered' ? (m.to_vendor === 'web' ? 'seen' : 'passed_on')
    : m.status === 'claimed' ? 'picked_up'
    : m.status === 'dropped' ? 'not_delivered'
    : m.status === 'pending' && m.note === 'key_check' ? 'key_check'
    : m.to_paused ? 'held'
    : m.status === 'pending' && quiet ? 'quiet_hours'
    : m.to_vendor === 'web' ? 'in_web_inbox'
    : !m.first_rung_at ? 'queued'
    : m.to_ring_status !== null && (m.to_ring_status < 200 || m.to_ring_status >= 300) ? 'doorbell_off'
    : m.next_ring_at === null ? 'stalled'
    : m.ring_count >= notAnsweringAfterRings ? 'not_answering' : 'rung';
}

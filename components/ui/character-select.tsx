import { Field, Select } from './form'

export function CharacterSelect({ characters, required = false, name = 'characterId', label = 'Character' }: { characters: { id: string; name: string }[]; required?: boolean; name?: string; label?: string }) {
  return (
    <Field label={label}>
      <Select name={name} required={required} options={[...(required ? [] : [{ value: '', label: 'All / none' }]), ...characters.map(c => ({ value: c.id, label: c.name }))]} />
    </Field>
  )
}

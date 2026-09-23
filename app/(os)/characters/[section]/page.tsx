import { redirect } from 'next/navigation'
import { SectionPlaceholder } from '@/components/shell/module-pages'

export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params
  if (section === 'library') redirect('/characters')
  return <SectionPlaceholder href="/characters" slug={section} />
}

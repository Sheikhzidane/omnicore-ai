import { SectionPlaceholder } from '@/components/shell/module-pages'

export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params
  return <SectionPlaceholder href="/growth" slug={section} />
}

type Props<T> = { item: T };
export function Card<T>({ item }: Props<T>) {
  return <iframe src={String(item)} />;
}

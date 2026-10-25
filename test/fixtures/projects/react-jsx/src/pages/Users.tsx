import { Routes, Route } from 'react-router-dom';
export default function Users() {
  return (
    <Routes>
      <Route index element={<List />} />
      <Route path=":id" element={<Detail />} />
      <Route path="new" element={<Create />} />
    </Routes>
  );
}

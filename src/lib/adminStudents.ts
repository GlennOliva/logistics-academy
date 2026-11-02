export const ADMIN_STUDENTS_PAGE_SIZE = 25

export type AdminStudentSearchFields = {
  user_id: string
  email: string
  full_name: string
}

export function filterAdminStudents<T extends AdminStudentSearchFields>(
  students: T[],
  search: string,
): T[] {
  const term = search.trim().toLowerCase()
  if (!term) return students
  return students.filter(
    (student) =>
      student.full_name.toLowerCase().includes(term) ||
      student.user_id.toLowerCase().includes(term) ||
      (student.email ? student.email.toLowerCase().includes(term) : false),
  )
}

export function paginateAdminStudents<T>(
  students: T[],
  page: number,
  pageSize = ADMIN_STUDENTS_PAGE_SIZE,
) {
  const safePageSize = Math.max(1, Math.floor(pageSize))
  const pageCount = Math.max(1, Math.ceil(students.length / safePageSize))
  const currentPage = Math.min(Math.max(1, Math.floor(page)), pageCount)
  const startIndex = (currentPage - 1) * safePageSize
  const items = students.slice(startIndex, startIndex + safePageSize)
  return {
    items,
    currentPage,
    pageCount,
    start: students.length === 0 ? 0 : startIndex + 1,
    end: Math.min(startIndex + safePageSize, students.length),
    total: students.length,
  }
}

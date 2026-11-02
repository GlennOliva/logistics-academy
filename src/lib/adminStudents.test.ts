import { describe, expect, it } from 'vitest'

import {
  ADMIN_STUDENTS_PAGE_SIZE,
  filterAdminStudents,
  paginateAdminStudents,
} from './adminStudents'

const students = [
  { user_id: '11111111-1111-4111-8111-111111111111', full_name: 'Angela Cruz', email: 'angela@example.test' },
  { user_id: '22222222-2222-4222-8222-222222222222', full_name: 'Ben Santos', email: 'ben@example.test' },
  { user_id: '33333333-3333-4333-8333-333333333333', full_name: 'Cara Lim', email: 'cara@logistics.test' },
]

describe('filterAdminStudents', () => {
  it('searches by name, email, and user id without changing the source', () => {
    expect(filterAdminStudents(students, 'angela')).toEqual([students[0]])
    expect(filterAdminStudents(students, 'BEN@EXAMPLE')).toEqual([students[1]])
    expect(filterAdminStudents(students, '33333333')).toEqual([students[2]])
    expect(filterAdminStudents(students, '  ')).toBe(students)
  })

  it('returns no matches instead of falling back to all students', () => {
    expect(filterAdminStudents(students, 'missing')).toEqual([])
  })
})

describe('paginateAdminStudents', () => {
  it('slices the requested page and reports its range', () => {
    const page = paginateAdminStudents(students, 2, 2)
    expect(page).toMatchObject({ currentPage: 2, pageCount: 2, start: 3, end: 3, total: 3 })
    expect(page.items).toEqual([students[2]])
  })

  it('clamps out-of-range pages and empty results', () => {
    expect(paginateAdminStudents(students, 99, 2)).toMatchObject({ currentPage: 2, start: 3, end: 3 })
    expect(paginateAdminStudents([], 1)).toEqual({
      items: [],
      currentPage: 1,
      pageCount: 1,
      start: 0,
      end: 0,
      total: 0,
    })
  })

  it('uses the shared page size by default', () => {
    const many = Array.from({ length: ADMIN_STUDENTS_PAGE_SIZE + 1 }, (_, index) => index)
    expect(paginateAdminStudents(many, 2)).toMatchObject({
      currentPage: 2,
      pageCount: 2,
      start: ADMIN_STUDENTS_PAGE_SIZE + 1,
      end: ADMIN_STUDENTS_PAGE_SIZE + 1,
      total: ADMIN_STUDENTS_PAGE_SIZE + 1,
    })
  })
})

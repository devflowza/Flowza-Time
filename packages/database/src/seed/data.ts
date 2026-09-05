export const ORG = { id: '00000000-0000-4000-a000-000000000001', companyCode: 'ALBAHJA', legalName: 'Al Bahja Trading & Contracting LLC', displayName: 'Al Bahja Trading', timezone: 'Asia/Muscat', country: 'OM', currency: 'OMR' };

export const BRANCHES = [
  { code: 'MCT-HQ', name: 'Muscat Head Office', nameAr: 'المكتب الرئيسي - مسقط', city: 'Muscat', lat: 23.5880, lng: 58.3829, weight: 36 },
  { code: 'SOH', name: 'Sohar Industrial', nameAr: 'صحار الصناعية', city: 'Sohar', lat: 24.3475, lng: 56.7094, weight: 20 },
  { code: 'SLL', name: 'Salalah Branch', nameAr: 'فرع صلالة', city: 'Salalah', lat: 17.0151, lng: 54.0924, weight: 18 },
  { code: 'NZW', name: 'Nizwa Branch', nameAr: 'فرع نزوى', city: 'Nizwa', lat: 22.9333, lng: 57.5333, weight: 14 },
  { code: 'SUR', name: 'Sur Warehouse', nameAr: 'مستودع صور', city: 'Sur', lat: 22.5667, lng: 59.5289, weight: 12 },
] as const;

export const DEPARTMENTS = ['Finance', 'Human Resources', 'Operations', 'Sales', 'Warehouse', 'Information Technology', 'Maintenance', 'Security', 'Procurement', 'Marketing', 'Legal', 'Customer Service', 'Logistics', 'Quality Assurance', 'Projects', 'Administration', 'Production', 'Fleet', 'Training', 'Facilities'] as const;
export const DESIGNATIONS = [['MGR', 'Manager', 5], ['SUP', 'Supervisor', 4], ['SR', 'Senior Officer', 3], ['OFF', 'Officer', 2], ['TECH', 'Technician', 2], ['ASST', 'Assistant', 1], ['DRV', 'Driver', 1], ['GRD', 'Security Guard', 1]] as const;

export const FIRST_NAMES_M = ['Ahmed', 'Mohammed', 'Salim', 'Khalid', 'Said', 'Hamed', 'Yousuf', 'Ali', 'Nasser', 'Talal', 'Rashid', 'Saif', 'Majid', 'Faisal', 'Sultan', 'Hilal', 'Abdullah', 'Hassan', 'Rajesh', 'Suresh', 'Arun', 'Vijay', 'Imran', 'Bilal', 'Tariq', 'Nadeem', 'Kamal', 'Rahim', 'Jose', 'Mark', 'Ramon', 'Mahmoud', 'Karim', 'Omar', 'Ibrahim', 'Waleed'];
export const FIRST_NAMES_F = ['Fatma', 'Aisha', 'Maryam', 'Salma', 'Noor', 'Huda', 'Zainab', 'Amal', 'Shaima', 'Laila', 'Priya', 'Anita', 'Deepa', 'Sana', 'Farah', 'Maria', 'Grace', 'Joy', 'Mona', 'Hana'];
export const LAST_NAMES = ['Al Balushi', 'Al Harthi', 'Al Busaidi', 'Al Hinai', 'Al Rawahi', 'Al Siyabi', 'Al Kindi', 'Al Amri', 'Al Maskari', 'Al Zadjali', 'Al Habsi', 'Al Farsi', 'Kumar', 'Nair', 'Sharma', 'Pillai', 'Khan', 'Ahmed', 'Hussain', 'Rahman', 'Santos', 'Reyes', 'Cruz', 'Hassan', 'Mostafa', 'Ibrahim'];
export const NATIONALITIES: Array<[string, number]> = [['OM', 0.45], ['IN', 0.25], ['PK', 0.1], ['BD', 0.08], ['PH', 0.06], ['EG', 0.06]];

export const SHIFTS = [
  { code: 'MORNING', name: 'Morning 08:00–17:00', nameAr: 'صباحية', type: 'FIXED', start: '08:00', end: '17:00', breaks: [{ start: '13:00', end: '14:00', paid: false }], color: '#1f9873' },
  { code: 'EARLY', name: 'Early 07:00–15:00', nameAr: 'مبكرة', type: 'FIXED', start: '07:00', end: '15:00', breaks: [{ minutes: 30, paid: false }], color: '#175cd3' },
  { code: 'EVENING', name: 'Evening 15:00–23:00', nameAr: 'مسائية', type: 'FIXED', start: '15:00', end: '23:00', breaks: [{ minutes: 30, paid: false }], color: '#b54708' },
  { code: 'NIGHT', name: 'Night 22:00–06:00', nameAr: 'ليلية', type: 'FIXED', start: '22:00', end: '06:00', breaks: [{ minutes: 30, paid: true }], color: '#4b3fa3' },
  { code: 'FLEX8', name: 'Flexible 8h', nameAr: 'مرنة 8 ساعات', type: 'FLEXIBLE', start: null, end: null, requiredMinutes: 480, coreStart: '10:00', coreEnd: '14:00', breaks: [{ minutes: 45, paid: false }], color: '#667085' },
] as const;

export const LEAVE_TYPES = [['ANNUAL', 'Annual Leave', 'إجازة سنوية', true], ['SICK', 'Sick Leave', 'إجازة مرضية', true], ['EMERGENCY', 'Emergency Leave', 'إجازة طارئة', true], ['UNPAID', 'Unpaid Leave', 'إجازة بدون راتب', false]] as const;

/** Oman public holidays 2026 (tentative where moon-sighting dependent). */
export const HOLIDAYS_2026 = [
  { name: 'New Year', date: '2026-01-01', type: 'PUBLIC', tentative: false },
  { name: 'Isra and Miraj', date: '2026-01-16', type: 'RELIGIOUS', tentative: true },
  { name: 'Eid al-Fitr', date: '2026-03-20', end: '2026-03-23', type: 'RELIGIOUS', tentative: true },
  { name: 'Eid al-Adha', date: '2026-05-26', end: '2026-05-29', type: 'RELIGIOUS', tentative: true },
  { name: 'Islamic New Year', date: '2026-06-16', type: 'RELIGIOUS', tentative: true },
  { name: 'Prophet\'s Birthday', date: '2026-08-25', type: 'RELIGIOUS', tentative: true },
  { name: 'Renaissance Day', date: '2026-07-23', type: 'PUBLIC', tentative: false },
  { name: 'National Day', date: '2026-11-18', end: '2026-11-19', type: 'PUBLIC', tentative: false },
] as const;

export const DEVICES = [
  // HQ (8)
  { code: 'MCT-ENT-01', name: 'HQ Main Entrance', branch: 'MCT-HQ', provider: 'mock', manufacturer: 'ZKTeco', model: 'SpeedFace-V5L', scenario: 'healthy' },
  { code: 'MCT-ENT-02', name: 'HQ Main Entrance 2', branch: 'MCT-HQ', provider: 'mock', manufacturer: 'ZKTeco', model: 'SpeedFace-V5L', scenario: 'healthy' },
  { code: 'MCT-FLR-03', name: 'HQ 3rd Floor', branch: 'MCT-HQ', provider: 'mock', manufacturer: 'Hikvision', model: 'DS-K1T343MFWX', scenario: 'healthy' },
  { code: 'MCT-FLR-05', name: 'HQ 5th Floor', branch: 'MCT-HQ', provider: 'mock', manufacturer: 'Hikvision', model: 'DS-K1T343MFWX', scenario: 'flaky' },
  { code: 'MCT-PKG-01', name: 'HQ Parking Gate', branch: 'MCT-HQ', provider: 'mock', manufacturer: 'Suprema', model: 'BioStation 3', scenario: 'slow' },
  { code: 'MCT-CAF-01', name: 'HQ Cafeteria', branch: 'MCT-HQ', provider: 'mock', manufacturer: 'Anviz', model: 'FaceDeep 5', scenario: 'duplicates' },
  { code: 'MCT-SRV-01', name: 'HQ Server Room', branch: 'MCT-HQ', provider: 'zkteco_push', manufacturer: 'ZKTeco', model: 'F22', scenario: null },
  { code: 'MCT-ANX-01', name: 'HQ Annex (legacy)', branch: 'MCT-HQ', provider: 'hikvision_isapi', manufacturer: 'Hikvision', model: 'DS-K1T804MF', scenario: null },
  // Sohar (4)
  { code: 'SOH-GT-01', name: 'Sohar Gate A', branch: 'SOH', provider: 'mock', manufacturer: 'ZKTeco', model: 'uFace 800', scenario: 'healthy' },
  { code: 'SOH-GT-02', name: 'Sohar Gate B', branch: 'SOH', provider: 'mock', manufacturer: 'ZKTeco', model: 'uFace 800', scenario: 'unknown_employees' },
  { code: 'SOH-WH-01', name: 'Sohar Warehouse', branch: 'SOH', provider: 'mock', manufacturer: 'eSSL', model: 'X990', scenario: 'offline' },
  { code: 'SOH-OFF-01', name: 'Sohar Office', branch: 'SOH', provider: 'zkteco_push', manufacturer: 'ZKTeco', model: 'K40', scenario: null },
  // Salalah (3)
  { code: 'SLL-ENT-01', name: 'Salalah Entrance', branch: 'SLL', provider: 'mock', manufacturer: 'Suprema', model: 'BioLite N2', scenario: 'healthy' },
  { code: 'SLL-WH-01', name: 'Salalah Warehouse', branch: 'SLL', provider: 'mock', manufacturer: 'ZKTeco', model: 'MB460', scenario: 'healthy' },
  { code: 'SLL-BCK-01', name: 'Salalah Back Gate', branch: 'SLL', provider: 'suprema_biostar2', manufacturer: 'Suprema', model: 'FaceStation F2', scenario: null },
  // Nizwa (3)
  { code: 'NZW-ENT-01', name: 'Nizwa Entrance', branch: 'NZW', provider: 'mock', manufacturer: 'Anviz', model: 'W2 Pro', scenario: 'healthy' },
  { code: 'NZW-WS-01', name: 'Nizwa Workshop', branch: 'NZW', provider: 'mock', manufacturer: 'FingerTec', model: 'Face ID 5', scenario: 'large_batches' },
  { code: 'NZW-OFF-01', name: 'Nizwa Office', branch: 'NZW', provider: 'zkteco_push', manufacturer: 'ZKTeco', model: 'F18', scenario: null },
  // Sur (2)
  { code: 'SUR-GT-01', name: 'Sur Gate', branch: 'SUR', provider: 'mock', manufacturer: 'Matrix', model: 'COSEC ARGO FACE', scenario: 'healthy' },
  { code: 'SUR-OFF-01', name: 'Sur Office', branch: 'SUR', provider: 'mock', manufacturer: 'Nitgen', model: 'eNBioAccess-T9', scenario: 'offline' },
] as const;

export const USERS = [
  { email: 'owner@albahja.example', name: 'Khalid Al Harthi', role: 'owner', allBranches: true, branches: [] as string[] },
  { email: 'hr@albahja.example', name: 'Fatma Al Balushi', role: 'hr_admin', allBranches: true, branches: [] as string[] },
  { email: 'sohar.manager@albahja.example', name: 'Said Al Rawahi', role: 'branch_manager', allBranches: false, branches: ['SOH'] },
  { email: 'devices@albahja.example', name: 'Rajesh Kumar', role: 'attendance_admin', allBranches: true, branches: [] as string[] },
  { email: 'payroll@albahja.example', name: 'Maryam Al Siyabi', role: 'payroll', allBranches: true, branches: [] as string[] },
  { email: 'employee@albahja.example', name: 'Ahmed Al Hinai', role: 'employee', allBranches: true, branches: [] as string[] },
] as const;
export const SEED_PASSWORD = 'FlowZa-Demo-2026!';

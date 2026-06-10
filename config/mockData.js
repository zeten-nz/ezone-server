const bcrypt = require('bcryptjs');

const mockEmployees = [
  { full_name: 'Alisher Ismoilov', username: 'alisher1', phone: '+998901234567', branch_code: 'BR001' },
  { full_name: 'Dilshod Rashidov', username: 'dilshod1', phone: '+998902345678', branch_code: 'BR002' },
  { full_name: 'Faridun Nazarov', username: 'faridun1', phone: '+998903456789', branch_code: 'BR003' },
  { full_name: 'Gulnora Shodmonova', username: 'gulnora1', phone: '+998904567890', branch_code: 'BR001' },
  { full_name: 'Hamid Karimov', username: 'hamid1', phone: '+998905678901', branch_code: 'BR002' },
  { full_name: 'Javohir Omonov', username: 'javohir1', phone: '+998906789012', branch_code: 'BR003' },
  { full_name: 'Kamola Abdullayeva', username: 'kamola1', phone: '+998907890123', branch_code: 'BR001' },
  { full_name: 'Latif Sunnatov', username: 'latif1', phone: '+998908901234', branch_code: 'BR002' },
  { full_name: 'Mehroj Qodirjanov', username: 'mehroj1', phone: '+998909012345', branch_code: 'BR003' },
  { full_name: 'Nodira Abdullayeva', username: 'nodira1', phone: '+998910123456', branch_code: 'BR001' },
];

const carBrands = ['Chevrolet', 'Toyota', 'Hyundai', 'Kia', 'Volkswagen', 'BMW', 'Mercedes', 'Ford'];
const cities = ['Tashkent', 'Samarkand', 'Bukhara', 'Fergana', 'Andijan', 'Namangan'];
const manufacturers = ['STAG', 'BRC', 'Impco', 'Tomasetto', 'Landi Renzo'];

const generateMockWarrantyForm = (employeeId, index) => {
  const today = new Date();
  const formDate = new Date(today.getTime() - Math.random() * 90 * 24 * 60 * 60 * 1000);

  const brand = carBrands[Math.floor(Math.random() * carBrands.length)];
  const city = cities[Math.floor(Math.random() * cities.length)];
  const plateNumber = `01A${Math.floor(Math.random() * 900) + 100}${Math.floor(Math.random() * 9)}`;

  return {
    employee_id: employeeId,
    region: 'Tashkent',
    city: city,
    district: 'Urban',
    organization_name: `Garaz ${index}`,
    organization_phone: '+998901234567',
    installer_full_name: mockEmployees.find(e => e.full_name)?.full_name || 'Installer',
    warranty_book_number: `GB${employeeId}${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
    installation_date: formDate.toISOString().split('T')[0],
    vehicle_brand: brand,
    vehicle_model: ['Model A', 'Model B', 'Model S', 'Model X'][Math.floor(Math.random() * 4)],
    vehicle_production_year: 2015 + Math.floor(Math.random() * 9),
    vehicle_plate_number: plateNumber,
    vehicle_vin: `VIN${employeeId}${Math.random().toString(36).substring(2, 15).toUpperCase()}`,
    vehicle_engine_volume: `${1.2 + Math.floor(Math.random() * 20) / 10}L`,
    vehicle_engine_power: `${90 + Math.floor(Math.random() * 100)}hp`,
    vehicle_mileage: Math.floor(Math.random() * 150000),
    owner_full_name: `Owner ${index}`,
    owner_phone: `+99890${Math.floor(Math.random() * 9000000) + 1000000}`,
    reducer_fuel_type: 'LPG',
    reducer_manufacturer: manufacturers[Math.floor(Math.random() * manufacturers.length)],
    reducer_serial_number: `R${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
    cylinder_fuel_type: 'LPG',
    cylinder_manufacturer: manufacturers[Math.floor(Math.random() * manufacturers.length)],
    cylinder_serial_number: `C${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
    stag_controller_manufacturer: 'STAG',
    stag_controller_serial_number: `S${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
    injector_rail_manufacturer: manufacturers[Math.floor(Math.random() * manufacturers.length)],
    injector_rail_serial_number: `I${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
  };
};

const generateMockData = async (connection) => {
  try {
    const adminPassword = await bcrypt.hash('admin123', 10);

    // Create admin
    await connection.execute(
      `INSERT INTO users (full_name, username, password, phone, branch_code, role, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['System Administrator', 'admin', adminPassword, '+998901234567', 'ADMIN', 'ADMIN', true]
    );

    // Create employees with mock data
    const warranties = [];

    for (let i = 0; i < mockEmployees.length; i++) {
      const emp = mockEmployees[i];
      const password = await bcrypt.hash('emp123', 10);

      const [result] = await connection.execute(
        `INSERT INTO users (full_name, username, password, phone, branch_code, role, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [emp.full_name, emp.username, password, emp.phone, emp.branch_code, 'EMPLOYEE', true]
      );

      const employeeId = result.insertId;

      // Generate 10-20 warranty forms for each employee
      const formCount = 10 + Math.floor(Math.random() * 11);
      for (let j = 0; j < formCount; j++) {
        warranties.push({ ...generateMockWarrantyForm(employeeId, j + 1), employee_id: employeeId });
      }
    }

    // Insert all warranties
    for (const warranty of warranties) {
      await connection.execute(
        `INSERT INTO warranty_forms (
          employee_id, region, city, district, organization_name, organization_phone,
          installer_full_name, warranty_book_number, installation_date,
          vehicle_brand, vehicle_model, vehicle_production_year, vehicle_plate_number,
          vehicle_vin, vehicle_engine_volume, vehicle_engine_power, vehicle_mileage,
          owner_full_name, owner_phone,
          reducer_fuel_type, reducer_manufacturer, reducer_serial_number,
          cylinder_fuel_type, cylinder_manufacturer, cylinder_serial_number,
          stag_controller_manufacturer, stag_controller_serial_number,
          injector_rail_manufacturer, injector_rail_serial_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          warranty.employee_id, warranty.region, warranty.city, warranty.district,
          warranty.organization_name, warranty.organization_phone, warranty.installer_full_name,
          warranty.warranty_book_number, warranty.installation_date, warranty.vehicle_brand,
          warranty.vehicle_model, warranty.vehicle_production_year, warranty.vehicle_plate_number,
          warranty.vehicle_vin, warranty.vehicle_engine_volume, warranty.vehicle_engine_power,
          warranty.vehicle_mileage, warranty.owner_full_name, warranty.owner_phone,
          warranty.reducer_fuel_type, warranty.reducer_manufacturer, warranty.reducer_serial_number,
          warranty.cylinder_fuel_type, warranty.cylinder_manufacturer, warranty.cylinder_serial_number,
          warranty.stag_controller_manufacturer, warranty.stag_controller_serial_number,
          warranty.injector_rail_manufacturer, warranty.injector_rail_serial_number
        ]
      );
    }

    console.log('Mock data created successfully!');
    console.log(`- 1 Admin user`);
    console.log(`- 10 Employee users`);
    console.log(`- ${warranties.length} Warranty forms`);

    return true;
  } catch (error) {
    console.error('Error creating mock data:', error);
    return false;
  }
};

module.exports = { generateMockData };

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
const carModels = ['Cobalt', 'Nexia', 'Camry', 'Sportage', 'Malibu', 'Gentra', 'Spark', 'Tracker'];
const cities = ['Tashkent', 'Samarkand', 'Bukhara', 'Fergana', 'Andijan', 'Namangan'];

// Seed catalog — a small realistic set per fixed equipment slot, so
// generated mock warranties have real products to reference (matching the
// "no free-text equipment" rule the real form now enforces).
const mockCatalog = [
  { category: 'REDUCER', brand: 'STAG', model: 'R02' },
  { category: 'REDUCER', brand: 'BRC', model: 'SQ32' },
  { category: 'CYLINDER', brand: 'STAKO', model: 'Cyl-50L' },
  { category: 'CYLINDER', brand: 'Vitkovice', model: 'Cyl-60L' },
  { category: 'CONTROLLER', brand: 'STAG', model: 'QMAX BASIC' },
  { category: 'CONTROLLER', brand: 'STAG', model: 'QMAX PLUS' },
  { category: 'INJECTOR_RAIL', brand: 'Valtek', model: 'Rail-4' },
  { category: 'INJECTOR_RAIL', brand: 'Hana', model: 'Rail-6' },
];

const EQUIPMENT_TYPES = ['REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL'];

const generateMockWarrantyForm = (employeeId, employee, index) => {
  const today = new Date();
  const formDate = new Date(today.getTime() - Math.random() * 90 * 24 * 60 * 60 * 1000);

  const brand = carBrands[Math.floor(Math.random() * carBrands.length)];
  const model = carModels[Math.floor(Math.random() * carModels.length)];
  const city = cities[Math.floor(Math.random() * cities.length)];
  const plateNumber = `01A${Math.floor(Math.random() * 900) + 100}${Math.floor(Math.random() * 9)}`;

  return {
    employee_id: employeeId,
    installer_region: 'Tashkent',
    city,
    installer_district: 'Urban',
    installer_branch: `Garaz ${employee.branch_code}`,
    organization_phone: '+998901234567',
    installer_full_name: employee.full_name,
    installer_phone: employee.phone,
    installer_branch_code: employee.branch_code,
    warranty_book_number: `GB${employeeId}${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
    installation_date: formDate.toISOString().split('T')[0],
    // One fuel type for the whole installation, not per equipment row.
    fuel_type: Math.random() < 0.5 ? 'LPG' : 'CNG',
    vehicle_name: `${brand} ${model}`,
    vehicle_production_year: 2015 + Math.floor(Math.random() * 9),
    // Every 5th record has no plate yet — exercises the now-optional field.
    vehicle_plate_number: index % 5 === 0 ? null : plateNumber,
    vehicle_vin: `VIN${employeeId}${Math.random().toString(36).substring(2, 15).toUpperCase()}`,
    vehicle_mileage: Math.floor(Math.random() * 150000),
    owner_full_name: `Owner ${index}`,
    owner_phone: `+99890${Math.floor(Math.random() * 9000000) + 1000000}`,
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

    // Seed the product catalog once, capturing each row's id/brand/model so
    // mock warranty_equipment rows can reference real catalog entries.
    const catalogByCategory = new Map();
    for (const product of mockCatalog) {
      const [result] = await connection.execute(
        'INSERT INTO products (category, brand, model) VALUES (?, ?, ?)',
        [product.category, product.brand, product.model]
      );
      const entry = { id: result.insertId, brand: product.brand, model: product.model };
      if (!catalogByCategory.has(product.category)) catalogByCategory.set(product.category, []);
      catalogByCategory.get(product.category).push(entry);
    }
    const pickProduct = (category) => {
      const options = catalogByCategory.get(category);
      return options[Math.floor(Math.random() * options.length)];
    };

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
        warranties.push(generateMockWarrantyForm(employeeId, emp, j + 1));
      }
    }

    // Insert all warranties, each with its 4 fixed equipment rows.
    for (const warranty of warranties) {
      const [result] = await connection.execute(
        `INSERT INTO warranty_forms (
          employee_id, installer_region, city, installer_district, installer_branch, organization_phone,
          installer_full_name, installer_phone, installer_branch_code,
          warranty_book_number, installation_date, fuel_type,
          vehicle_name, vehicle_production_year, vehicle_plate_number,
          vehicle_vin, vehicle_mileage,
          owner_full_name, owner_phone
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          warranty.employee_id, warranty.installer_region, warranty.city, warranty.installer_district,
          warranty.installer_branch, warranty.organization_phone,
          warranty.installer_full_name, warranty.installer_phone, warranty.installer_branch_code,
          warranty.warranty_book_number, warranty.installation_date, warranty.fuel_type,
          warranty.vehicle_name, warranty.vehicle_production_year, warranty.vehicle_plate_number,
          warranty.vehicle_vin, warranty.vehicle_mileage,
          warranty.owner_full_name, warranty.owner_phone,
        ]
      );

      const warrantyFormId = result.insertId;
      for (const equipmentType of EQUIPMENT_TYPES) {
        const product = pickProduct(equipmentType);
        await connection.execute(
          `INSERT INTO warranty_equipment (warranty_form_id, equipment_type, product_id, product_name, serial_number)
           VALUES (?, ?, ?, ?, ?)`,
          [
            warrantyFormId, equipmentType, product.id, `${product.brand} ${product.model}`,
            `${equipmentType[0]}${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
          ]
        );
      }
    }

    console.log('Mock data created successfully!');
    console.log(`- 1 Admin user`);
    console.log(`- 10 Employee users`);
    console.log(`- ${mockCatalog.length} Catalog products`);
    console.log(`- ${warranties.length} Warranty forms (each with 4 equipment rows)`);

    return true;
  } catch (error) {
    console.error('Error creating mock data:', error);
    return false;
  }
};

module.exports = { generateMockData };

// SystemVerilog module with advanced features
module fifo_controller (
  input logic clk,
  input logic rst,
  input logic write_en,
  input logic read_en,
  input logic [31:0] data_in,
  output logic [31:0] data_out,
  output logic full,
  output logic empty
);

  logic [31:0] fifo_mem [0:15];
  logic [3:0] wr_ptr, rd_ptr;

  always_ff @(posedge clk or posedge rst) begin
    if (rst) begin
      wr_ptr <= 4'b0;
      rd_ptr <= 4'b0;
    end else begin
      if (write_en)
        wr_ptr <= wr_ptr + 1;
      if (read_en)
        rd_ptr <= rd_ptr + 1;
    end
  end

  assign full = (wr_ptr == {~rd_ptr[3], rd_ptr[2:0]});
  assign empty = (wr_ptr == rd_ptr);

endmodule
